"""Tree-first interaction against the real service, using explicitly synthetic answers."""
import argparse, json, re, math
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_acceptance import Service, seed, node, request, ai_check, no_overflow


def specimen(work):
    roots = [node('goal', '读书会报名页，首先要解决什么？', answered=True),
             node('privacy', '哪些信息需要保护？', answered=True),
             node('scope', '首版的边界是什么？', answered=True),
             node('notice', '空出名额时，谁负责通知？', deps=['goal'], round=2, answered=True)]
    for n, text in zip(roots, ['先让报名和取消有个统一入口。', '只收姓名和联系方式。', '先服务一个读书会。', '由组织者联系候补的人，先不做自动消息。']):
        n['answer']['text'] = text
    tree = seed(roots, round=2)
    tree.update(session_id='synthetic-bud-note-r24', topic='周末读书会 · 交互试稿（示例）')
    service = Service(work, tree)
    questions = [
        node('capacity', '有人取消后，空位怎么安排？', deps=['goal'], round=3, options=[{'id':'ask','label':'先通知，等对方确认'},{'id':'auto','label':'按候补顺序自动递补'}]),
        node('channels', '首版要通过哪些渠道通知？', deps=['notice'], round=3, options=[{'id':'mail','label':'邮件通知'},{'id':'inbox','label':'站内通知'},{'id':'none','label':'都不需要','exclusive':True}]),
        node('delete', '活动结束后，信息保留多久？', deps=['privacy'], round=3),
        node('export', '名单需要导出吗？', deps=['scope'], round=3, options=[{'id':'yes','label':'提供导出'},{'id':'no','label':'先在页面查看'}]),
        node('success', '参与者报名成功后，看见什么？', deps=['privacy'], round=3)]
    questions[1].update(input='multi_choice', recommendation={'option_ids':['mail'],'reason':'先用一种通知方式跑通报名流程。','source_ids':['goal']})
    for n in questions:
        n['rationale'] = {'capacity':'决定名额在何时算被占用。','channels':'决定首版要开发和验收哪些通知渠道。','delete':'决定个人信息的保存期限。','export':'决定名单是否需要离开报名页面。','success':'决定参与者如何知道报名已经成功。'}[n['id']]
    code, result = request(service.url, '/round', {'round':3,'expected_revision':0,'nodes':questions})
    assert code == 200, result
    return service


def open_flower(page, id, edit=False):
    page.locator(f'.tree-node[data-node-id="{id}"]').click()
    expect(page.locator('#node-dialog')).to_have_attribute('data-node-id', id)
    expect(page.locator('#node-dialog')).to_have_css('transform','none')
    if edit:
        page.get_by_role('button', name='改', exact=True).click()
        expect(page.locator('#node-dialog')).to_have_attribute('data-mode', 'edit')


def confirm(page):
    page.get_by_role('button', name='就这么定', exact=True).click()
    expect(page.locator('#node-dialog')).not_to_be_visible()

def next_question(page,id):
    expect(page.locator('#next-question')).to_have_attribute('data-target',id)
    page.get_by_role('button',name='下一题 →',exact=True).click()
    expect(page.locator('#node-dialog')).to_have_attribute('data-node-id',id)
    expect(page.locator('#node-dialog')).to_have_css('transform','none')

def initial_specimen(work):
    questions=[node('purpose','这个报名页，先解决哪件事？',options=[{'id':'signup','label':'让报名有一个统一入口'},{'id':'notice','label':'及时通知活动变化'}]),
               node('audience','第一版给谁用？',options=[{'id':'club','label':'一个固定读书会'},{'id':'open','label':'面向所有感兴趣的人'}]),
               node('privacy','报名时，哪些信息真的需要留下？'),
               node('scope','名单需要导出吗？',options=[{'id':'yes','label':'提供导出'},{'id':'no','label':'先在页面查看'}])]
    for n,why in zip(questions,['决定第一版围绕哪个核心动作展开。','决定参与者的准入范围。','决定需要收集和保护的个人信息。','决定名单是否需要离开报名页面。']):n['rationale']=why
    tree=seed(questions);tree.update(session_id='synthetic-subtitle-band',topic='周末读书会 · 字幕带试稿（示例）')
    return Service(work,tree)


def same_centre(a,b):
    # Focus/next outlines change stroke bounds, not the flower's position.
    return all(abs(a[axis]+a[size]/2-b[axis]-b[size]/2)<.1 for axis,size in [('x','width'),('y','height')])


def native_camera(page,tree,zoom=1):
    # Compare the UI's final viewport with the renderer's own camera. This catches
    # application-level fit-to-ink overrides even when every branch path matches.
    result=page.evaluate('''async ({tree,zoom})=>{
      const {cameraFrame}=await import('/tree.mjs');
      const b=cameraFrame(tree),w=b.width/zoom,h=b.height/zoom;
      await new Promise(requestAnimationFrame);
      const canvas=document.querySelector('#tree-canvas');
      return {expected:[b.x+(b.width-w)/2,b.y+(b.height-h)/2,w,h],
        actual:canvas.getAttribute('viewBox').trim().split(/\\s+/).map(Number),
        zoom:Number(canvas.dataset.scale)};
    }''',{'tree':tree,'zoom':zoom})
    assert len(result['actual'])==4,result
    assert all(math.isclose(a,b,rel_tol=0,abs_tol=1e-6) for a,b in zip(result['actual'],result['expected'])),result
    assert math.isclose(result['zoom'],zoom,rel_tol=0,abs_tol=1e-6),result


def check_tail(page,id,kind):
    expect(page.locator('#bubble-link')).to_be_visible()
    expect(page.locator('#bubble-link')).to_have_attribute('data-target',id)
    expect(page.locator('#bubble-link')).to_have_attribute('data-kind',kind)
    fill=page.locator('.bubble-tail-fill')
    assert fill.evaluate('e=>getComputedStyle(e).fill')!='none'
    d=fill.get_attribute('d');assert d.endswith('Z'),d
    points=[float(n) for n in re.findall(r'-?\d+(?:\.\d+)?',d)]
    tip=points[4:6];hit=page.locator(f'.tree-node[data-node-id="{id}"] .tree-hit').bounding_box()
    assert 5<=math.hypot(tip[0]-hit['x']-hit['width']/2,tip[1]-hit['y']-hit['height']/2)<=12,(tip,hit)


def answer_layout(page):
    box=page.locator('#node-dialog').bounding_box()
    scene=page.locator('.tree-viewport').bounding_box()
    heading=page.locator('#question-heading').bounding_box()
    assert heading['y']+heading['height']<=scene['y'],(heading,scene)
    if page.locator('#node-dialog').get_attribute('data-placement')=='strip':
        assert scene['y']+scene['height']<=box['y'],(scene,box)
    else:
        assert box['width']<=248 and box['height']<=240,box
        trunk=page.locator('.tree-trunk').bounding_box()
        assert min(box['x']+box['width'],trunk['x']+trunk['width'])<=max(box['x'],trunk['x']) or min(box['y']+box['height'],trunk['y']+trunk['height'])<=max(box['y'],trunk['y']), (box,trunk)
    viewport=page.viewport_size
    assert box['x']>=0 and box['x']+box['width']<=viewport['width']
    assert box['y']+box['height']<=viewport['height'],box
    no_overflow(page)
    return box


def spoken_bud_layout(browser,out,report):
    service=initial_specimen(out/'initial-runtime')
    try:
        source=service.file.read_bytes()
        tree=json.loads(source)
        for width,height,label in [(1440,1000,'desktop'),(1280,720,'compact'),(390,844,'mobile')]:
            page=browser.new_page(viewport={'width':width,'height':height})
            page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.goto(service.url);page.wait_for_load_state('networkidle')
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=20000)
            native_camera(page,tree)
            expect(page.locator('.tree-node[data-status=pending]')).to_have_count(4)
            expect(page.locator('.tree-node[data-status=answered]')).to_have_count(0)
            for bud in page.locator('.tree-node[data-status=pending] use').all():expect(bud).to_be_visible()
            page.screenshot(path=str(out/f'{label}-01-buds.png'))
            hit=page.locator('.tree-node[data-node-id=purpose] .tree-hit')
            origin=hit.bounding_box()
            expect(page.locator('#bud-guide')).to_have_attribute('data-target','purpose')
            expect(page.locator('#bud-guide')).to_have_text('点这里开始')
            check_tail(page,'purpose','guide')
            page.locator('#bud-guide').click()
            expect(page.locator('#node-dialog')).to_have_css('transform','none')
            native_camera(page,tree)
            answer_layout(page)
            assert same_centre(origin,hit.bounding_box()), 'Opening the options moved the flower'
            expect(page.locator('#card input,#card textarea')).to_have_count(0)
            page.screenshot(path=str(out/f'{label}-02-question.png'))
            expect(page.locator('#node-dialog')).to_have_attribute('data-placement','bubble')
            check_tail(page,'purpose','options')
            assert float(page.locator('#node-dialog').evaluate('e=>getComputedStyle(e).borderTopLeftRadius').replace('px',''))>=24
            if label=='desktop':
                page.screenshot(path=str(out/'desktop-tree-hidden.png'),style='#tree-canvas{visibility:hidden!important}')
            page.get_by_label('让报名有一个统一入口',exact=True).check()
            page.screenshot(path=str(out/f'{label}-02-selected.png'))
            confirm(page)
            native_camera(page,tree)
            expect(page.locator('.tree-node[data-node-id=purpose] use')).to_have_attribute('href','#tree-flower')
            assert same_centre(origin,hit.bounding_box()), (origin,hit.bounding_box())
            expect(page.locator('#bud-guide')).to_be_visible()
            expect(page.locator('#bud-guide')).to_have_attribute('data-target','audience')
            expect(page.locator('#bud-guide')).to_have_text('接着聊这朵')
            check_tail(page,'audience','guide')
            page.screenshot(path=str(out/f'{label}-03-bloom.png'))
            open_flower(page,'purpose');answer_layout(page)
            expect(page.locator('#node-dialog input,#node-dialog textarea')).to_have_count(0)
            page.get_by_role('button',name='改',exact=True).click()
            page.get_by_label('及时通知活动变化',exact=True).check();confirm(page)
            open_flower(page,'purpose');expect(page.locator('#node-body .answer')).to_have_text('及时通知活动变化')
            page.screenshot(path=str(out/f'{label}-04-readback.png'))
            page.get_by_role('button',name='关闭',exact=True).click()
            page.locator('[data-tree-zoom="in"]').click()
            native_camera(page,tree,1.3)
            open_flower(page,'purpose')
            native_camera(page,tree,1.3)
            page.get_by_role('button',name='关闭',exact=True).click()
            native_camera(page,tree,1.3)
            page.set_viewport_size({'width':width+20,'height':height})
            native_camera(page,tree,1.3)
            page.set_viewport_size({'width':width,'height':height})
            page.locator('[data-tree-zoom="fit"]').click()
            native_camera(page,tree)
            next_question(page,'audience');answer_layout(page)
            expect(page.locator('.previous-answer .previous-excerpt')).to_have_text('及时通知活动变化')
            page.get_by_label('一个固定读书会',exact=True).check();confirm(page)
            next_question(page,'privacy');page.get_by_role('textbox').fill('只留名字和联系方式。')
            if label=='mobile':
                # Small visual area check, not a claim of physical-device keyboard coverage.
                page.set_viewport_size({'width':390,'height':540})
                page.wait_for_function("()=>document.querySelector('#node-dialog').getBoundingClientRect().bottom<=innerHeight")
                answer_layout(page)
                expect(page.get_by_role('textbox')).to_have_value('只留名字和联系方式。')
            confirm(page)
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(3)
            expect(page.locator('#bud-guide')).not_to_have_text('点这里开始')
            assert service.file.read_bytes()==source
            page.close()
        report['checks'].append('All-pending initial tree, desktop and 390 px mobile: visible buds → click → top question and flower speech bubble (short questions remain bubbles on compact desktop and mobile) → confirm/bloom at identical screen coordinates → readonly review → explicit 改 → Next and two more answers. Opening/closing never shifts the tree; small viewport retains input; no writes before round submission. Physical-device keyboard not tested.')
        report['checks'].append('Initial, opened and confirmed views use the renderer cameraFrame exactly. Explicit 1.3× zoom survives opening/closing a bubble and viewport resize; fit restores the native camera, without application-level fit-to-ink magnification.')
    finally:service.close()


def long_content_layout(browser,out,report):
    questions=[
        node('long-question','如果读书会临时取消，而且有参与者已经在路上、有人还没看到通知，这时第一版的报名页面应该先提供哪一种处理方式？',options=[{'id':'contact','label':'请组织者逐一联系'},{'id':'notice','label':'先在页面发布通知'}]),
        node('many-options','活动信息可以通过哪些渠道送达？',options=[{'id':'mail','label':'邮件通知'},{'id':'inbox','label':'站内消息'},{'id':'sms','label':'手机短信'},{'id':'group','label':'群内公告'},{'id':'none','label':'都不需要','exclusive':True}])]
    questions[1]['input']='multi_choice'
    tree=seed(questions);tree.update(session_id='synthetic-long-bubble-content',topic='长题与多选项回退 · 受控示例')
    service=Service(out/'long-content-runtime',tree)
    try:
        source=service.file.read_bytes()
        for width,height,label in [(1440,1000,'desktop'),(390,844,'mobile')]:
            page=browser.new_page(viewport={'width':width,'height':height})
            page.on('pageerror',lambda e:report['errors'].append(str(e)))
            try:
                page.goto(service.url);page.wait_for_load_state('networkidle')
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=20000)
                for question in questions:
                    open_flower(page,question['id'])
                    expect(page.locator('#question-heading #node-question')).to_have_text(question['question'])
                    expect(page.locator('#node-dialog #node-question')).to_have_count(0)
                    expect(page.locator('#node-dialog')).to_have_attribute('data-placement','strip')
                    expect(page.locator('#bubble-link')).to_be_hidden()
                    answer_layout(page)
                    selected=question['options'][:2] if question['input']=='multi_choice' else question['options'][:1]
                    for option in selected:page.get_by_label(option['label'],exact=True).check()
                    page.locator('.notes > summary').click()
                    note='  '+question['id']+' 的补充原话\n<保留内容，不改写>  '
                    page.get_by_label('补充说明（可选）',exact=True).fill(note)
                    page.get_by_role('button',name='关闭',exact=True).click()
                    expect(page.locator('#node-dialog')).not_to_be_visible()
                    expect(page.locator('#question-heading')).not_to_be_visible()
                    open_flower(page,question['id'])
                    expect(page.locator('#node-dialog')).to_have_attribute('data-placement','strip')
                    expect(page.locator('#question-heading #node-question')).to_have_text(question['question'])
                    for option in selected:expect(page.get_by_label(option['label'],exact=True)).to_be_checked()
                    expect(page.get_by_label('补充说明（可选）',exact=True)).to_have_value(note)
                    expect(page.locator(f'.tree-node[data-node-id="{question["id"]}"]')).to_have_attribute('data-status','pending')
                    no_overflow(page)
                    page.screenshot(path=str(out/f'{label}-{question["id"]}-retained.png'))
                    page.get_by_role('button',name='关闭',exact=True).click()
                    assert service.file.read_bytes()==source
            finally:page.close()
        report['checks'].append('Separate long-question and 5-option fixtures use the bottom paper strip while the question stays at the top. Desktop/mobile selection and exact optional text survive closing/reopening, flowers remain pending, and tree.json is unchanged without confirmation or submission.')
    finally:service.close()


def run(out):
    out.mkdir(parents=True, exist_ok=True)
    service = specimen(out/'runtime')
    report = {'kind':'Synthetic UI/API acceptance; real revision and recommendation logic, no AI interview or timing claim.', 'checks':[], 'errors':[]}
    try:
        ai_check(service)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width':1440,'height':1000})
            page.on('pageerror', lambda e:report['errors'].append(str(e)))
            page.add_init_script('''window.blooms=[];const original=Element.prototype.animate;
              Element.prototype.animate=function(frames,options){if(this.matches?.('.tree-symbol'))window.blooms.push({id:this.parentElement.dataset.nodeId,duration:options.duration});return original.call(this,frames,options)};''')
            page.goto(service.url);page.wait_for_load_state('networkidle')
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=20000)
            expect(page.locator('#node-dialog')).not_to_be_visible()
            expect(page.locator('#card input,#card textarea')).to_have_count(0)
            expect(page.locator('.tree-node[data-status=pending]')).to_have_count(5)
            expect(page.locator('#tree-bud circle')).to_have_count(0)
            expect(page.locator('#tree-bud path')).to_have_count(5)
            expect(page.locator('.tree-node.is-next')).to_have_count(1)
            for bud in page.locator('.tree-node[data-status=pending]').all():
                expect(bud.locator('use')).to_be_visible()
                box=bud.locator('use').bounding_box();assert box['width']>5 and box['height']>6,box
                expect(bud.locator('use')).to_have_css('animation-name','question-breathe' if bud.get_attribute('data-node-id')=='capacity' else 'none')
            expect(page.locator('#bud-guide')).to_have_text('点这里开始')
            expect(page.locator('#bud-guide')).to_have_attribute('data-target','capacity')
            frame=page.locator('#tree-canvas').get_attribute('viewBox')
            geometry = page.locator('.tree-branch').evaluate_all('a=>a.map(n=>n.getAttribute("d"))')
            source = service.file.read_bytes()
            page.screenshot(path=str(out/'01-tree.png'))

            next_question(page,'capacity')
            assert page.locator('#tree-canvas').get_attribute('viewBox')==frame
            paper=answer_layout(page)
            expect(page.locator('#node-dialog')).to_have_attribute('data-placement','bubble')
            assert paper['width']<=248 and paper['height']<=240,paper
            expect(page.locator('.previous-answer blockquote')).to_be_hidden()
            page.locator('.previous-answer summary').click();expect(page.locator('.previous-answer blockquote')).to_be_visible();page.locator('.previous-answer summary').click()
            expect(page.locator('.previous-answer blockquote')).to_have_text('先让报名和取消有个统一入口。')
            expect(page.locator('input:checked')).to_have_count(0)
            expect(page.locator('#confirm-answer')).to_be_disabled()
            expect(page.locator('.question-reason p')).to_be_hidden()
            page.screenshot(path=str(out/'02-question.png'))
            page.get_by_label('先通知，等对方确认',exact=True).check();confirm(page)
            page.wait_for_timeout(700);expect(page.locator('#node-dialog')).not_to_be_visible()
            expect(page.locator('#bud-guide')).not_to_have_text('点这里开始')
            expect(page.locator('.tree-node[data-node-id=capacity] use')).to_have_attribute('href','#tree-flower')
            assert any(a['id']=='capacity' and a['duration']==520 for a in page.evaluate('window.blooms'))
            next_question(page,'channels')
            for box in page.get_by_role('checkbox').all():expect(box).not_to_be_checked()
            expect(page.locator('.recommendation-info .w')).to_be_hidden()
            page.get_by_label('邮件通知',exact=True).check();page.get_by_label('站内通知',exact=True).check();confirm(page)

            open_flower(page,'capacity')
            expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            expect(page.locator('#node-dialog input,#node-dialog textarea')).to_have_count(0)
            expect(page.locator('#node-body .answer')).to_have_text('先通知，等对方确认')
            page.get_by_role('button',name='改',exact=True).click()
            expect(page.locator('.tree-node[data-node-id=capacity]')).to_have_attribute('data-status','answered')
            page.get_by_label('按候补顺序自动递补',exact=True).check();confirm(page)
            open_flower(page,'capacity');expect(page.locator('#node-body .answer')).to_have_text('按候补顺序自动递补')
            page.screenshot(path=str(out/'03-readback.png'))
            # Directly switch flowers while the note is open; no intermediate left-side form.
            next_question(page,'delete');page.get_by_role('textbox').fill('活动结束七天后删除。')
            next_question(page,'delete');expect(page.get_by_role('textbox')).to_have_value('活动结束七天后删除。');confirm(page)
            next_question(page,'export');page.get_by_label('先在页面查看',exact=True).check();confirm(page)
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(4)
            next_question(page,'success');page.get_by_role('textbox').fill('  显示报名成功\n保留原话 <不改写>  ')
            open_flower(page,'capacity');expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            next_question(page,'success');expect(page.get_by_role('textbox')).to_have_value('  显示报名成功\n保留原话 <不改写>  ')
            confirm(page)
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(5)
            expect(page.locator('#next-question')).to_have_count(0)
            # An explicitly reopened local draft also stays the current question until confirmed.
            open_flower(page,'capacity',edit=True);next_question(page,'capacity');confirm(page)
            report['checks'].append('Visible half-open buds; only the current bud breathes; Next never skips unconfirmed input and does not auto-open after confirmation. The question is above the tree; short options are in a narrow speech bubble by the flower; text/long choices use the paper strip; the tree never moves.')
            assert service.file.read_bytes()==source
            assert geometry==page.locator('.tree-branch').evaluate_all('a=>a.map(n=>n.getAttribute("d"))')
            report['checks'].append('Five consecutive answers; readonly readback; explicit draft edit; another two answers; note switching retains unconfirmed input; original bloom animation and branch geometry retained.')
            spoken_bud_layout(browser,out,report)
            long_content_layout(browser,out,report)
            page.get_by_role('button',name='回看汇总，提交本轮',exact=True).click()
            expect(page.locator('.summary-list li')).to_have_count(5)
            page.get_by_role('button',name='提交本轮答案',exact=True).click()
            expect(page.locator('#node-dialog')).not_to_be_visible()
            expect(page.locator('#meta')).to_have_attribute('data-revision','2')
            assert service.state()['nodes'][-1]['answer']['text']=='  显示报名成功\n保留原话 <不改写>  '
            report['checks'].append('Per-flower confirmation is still a local draft; only explicit round submission writes tree.json with the expected revision and original text.')

            open_flower(page,'goal')
            before=service.file.read_bytes();assert page.locator('#node-dialog input,#node-dialog textarea').count()==0
            assert service.file.read_bytes()==before
            page.get_by_role('button',name='改',exact=True).click()
            expect(page.locator('.tree-node[data-status=needs_review]')).to_have_count(4)
            page.get_by_role('textbox').fill('取消后不要自动通知，先由组织者联系。')
            # Simulate a real concurrent write after the UI formed its expected_revision.
            def concurrent(route):
                now=service.state()
                code,_=request(service.url,'/decision',{'id':'scope','expected_revision':now['revision'],'answer':{'option_ids':[],'text':'一个读书会，暂不收费。'}})
                assert code==200
                route.continue_()
            page.route('**/decision',concurrent,times=1)
            page.get_by_role('button',name='就这么定',exact=True).click()
            expect(page.locator('#message')).to_contain_text('revision changed')
            expect(page.get_by_role('textbox')).to_have_value('取消后不要自动通知，先由组织者联系。')
            assert service.state()['nodes'][0]['answer']['text']=='先让报名和取消有个统一入口。'
            confirm(page)
            open_flower(page,'capacity');next_question(page,'capacity')
            expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            page.get_by_role('button',name='仍然有效',exact=True).click()
            open_flower(page,'channels',edit=True)
            expect(page.locator('#confirm-answer')).to_be_disabled() # Its direct parent is still yellow.
            page.locator('.recommendation-info > summary').click()
            expect(page.locator('.recommendation-info')).to_contain_text('旧推荐已隐藏')
            expect(page.locator('.recommendation-badge')).to_have_count(0)
            page.screenshot(path=str(out/'04-yellow-review.png'))
            next_question(page,'notice');page.get_by_role('button',name='仍然有效',exact=True).click()
            expect(page.locator('#node-dialog')).not_to_be_visible()
            open_flower(page,'channels',edit=True)
            page.get_by_label('都不需要',exact=True).check()
            expect(page.get_by_label('邮件通知',exact=True)).not_to_be_checked()
            expect(page.get_by_label('站内通知',exact=True)).not_to_be_checked()
            confirm(page)
            for id in ['export']:
                open_flower(page,id);page.get_by_role('button',name='仍然有效',exact=True).click()
                expect(page.locator('#node-dialog')).not_to_be_visible()
            expect(page.locator('.tree-node[data-status=needs_review]')).to_have_count(0)
            expect(page.locator('#wait-elapsed')).to_be_visible()
            report['checks'].append('Editing a submitted flower uses /reopen and /decision, marks transitive dependants yellow, disables answers until prerequisites are confirmed, hides stale advice, and rejects/retries a real stale revision without losing an unrelated draft.')
            latest=service.state()
            code,_=request(service.url,'/round',{'round':4,'expected_revision':latest['revision'],'nodes':[node('last','还有什么边界需要说明？',deps=['scope'],round=4)]})
            assert code==200
            expect(page.locator('#next-question')).to_have_attribute('data-target','last')
            page.reload();expect(page.locator('#next-question')).to_have_attribute('data-target','last')
            expect(page.locator('#bud-guide')).not_to_have_text('点这里开始')
            page.emulate_media(reduced_motion='reduce')
            expect(page.locator('.tree-node.is-next use')).to_have_css('animation-name','none')
            next_question(page,'last')
            report['checks'].append('The first-use hint stays dismissed across rounds and reloads; reduced-motion preference disables the breathing animation.')
            no_overflow(page)
            browser.close()
        assert not report['errors'], report['errors']
        report['status']='passed'
    finally:
        service.close()
        (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--work',required=True,type=Path);args=parser.parse_args();run(args.work.resolve())
