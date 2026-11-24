"""Tree-first interaction against the real service, using explicitly synthetic answers."""
import argparse, json, math
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
    page.get_by_role('button', name='好了', exact=True).click()


def asking(page, id):
    expect(page.locator('#node-dialog')).to_have_attribute('data-node-id', id)
    expect(page.locator('#node-dialog')).to_have_css('transform', 'none')
    expect(page.locator('#mascot')).to_have_attribute('data-node-id', id)


def initial_specimen(work):
    questions=[node('purpose','这个报名页，先解决哪件事？',options=[{'id':'signup','label':'让报名有一个统一入口'},{'id':'notice','label':'及时通知活动变化'}]),
               node('audience','第一版给谁用？',options=[{'id':'club','label':'一个固定读书会'},{'id':'open','label':'面向所有感兴趣的人'}]),
               node('privacy','报名时，哪些信息真的需要留下？'),
               node('scope','名单需要导出吗？',options=[{'id':'yes','label':'提供导出'},{'id':'no','label':'先在页面查看'}])]
    for n,why in zip(questions,['决定第一版围绕哪个核心动作展开。','决定参与者的准入范围。','决定需要收集和保护的个人信息。','决定名单是否需要离开报名页面。']):n['rationale']=why
    tree=seed(questions);tree.update(session_id='synthetic-mascot-bubble',topic='周末读书会 · 麻薯提问（示例）')
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


def separate(a, b):
    return any(a[p] + a[s] <= b[p] or b[p] + b[s] <= a[p]
               for p, s in [('x', 'width'), ('y', 'height')])


def answer_layout(page, id):
    asking(page, id)
    dialog = page.locator('#node-dialog')
    mobile = page.viewport_size['width'] <= 720
    expect(dialog).to_have_attribute('data-placement', 'sheet' if mobile else 'bubble')
    expect(dialog.locator('#node-question')).to_be_visible()
    expect(page.locator('#mascot')).to_have_attribute('aria-hidden', 'true')
    expect(page.locator('#mascot')).to_have_css('transform', 'none')
    box = dialog.bounding_box()
    mascot = page.locator('#mascot').bounding_box()
    bud = page.locator(f'.tree-node[data-node-id="{id}"] .tree-hit').bounding_box()
    assert separate(box, bud) and separate(mascot, bud), (box, mascot, bud)
    mx = mascot['x'] + mascot['width'] / 2
    my = mascot['y'] + mascot['height'] * 0.67
    assert math.dist((mx, my), (bud['x'] + bud['width']/2, bud['y'] + bud['height']/2)) < 86
    assert box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width']
    assert box['y'] + box['height'] <= page.viewport_size['height'] + 1
    link = page.locator('#bubble-link')
    if mobile:
        expect(link).to_be_hidden()
        assert box['y'] + 1 >= page.locator('.tree-viewport').bounding_box()['y'] + page.locator('.tree-viewport').bounding_box()['height']
        assert box['y'] + box['height'] <= page.locator('#card').bounding_box()['y'] + 1
    else:
        expect(link).to_be_visible()
        expect(link).to_have_attribute('data-target', id)
        d = link.locator('.bubble-tail-fill').get_attribute('d')
        assert d.startswith('M') and d.endswith('Z') and d.count('M') == 1
        assert link.locator('.bubble-tail-edge').get_attribute('d') == d
        tip = [float(link.get_attribute('data-tip-x')), float(link.get_attribute('data-tip-y'))]
        assert 12 <= math.dist(tip, (mx, my)) <= 42, (tip, mascot)
    no_overflow(page)


def spoken_bud_layout(browser, out, report):
    service = initial_specimen(out / 'initial-runtime')
    try:
        source = service.file.read_bytes()
        tree = json.loads(source)
        for width, height, label in [(1440, 1000, 'desktop'), (721, 720, 'compact'),
                                     (720, 780, 'breakpoint'), (390, 844, 'mobile')]:
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(service.url)
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false', timeout=20000)
            native_camera(page, tree)
            expect(page.locator('#bud-guide,#question-heading,#next-question')).to_have_count(0)
            expect(page.locator('.tree-node[data-status=pending]')).to_have_count(4)
            expect(page.locator('.scene-count')).to_have_text('第 1 轮 · 还剩 4 题')
            expect(page.locator('#node-question')).to_be_focused()
            expect(page.locator('#reword-question')).to_be_visible()
            hit = page.locator('.tree-node[data-node-id=purpose] .tree-hit')
            origin = hit.bounding_box()
            answer_layout(page, 'purpose')
            page.screenshot(path=str(out / f'{label}-01-question.png'))
            radios = page.get_by_role('radio')
            radios.first.focus()
            page.keyboard.press('ArrowDown')
            expect(radios.last).to_be_focused()
            expect(radios.last).not_to_be_checked()
            page.keyboard.press('Space')
            answer_layout(page, 'audience')
            expect(page.locator('#node-question')).to_be_focused()
            expect(page.locator('.scene-count')).to_have_text('第 1 轮 · 还剩 3 题')
            expect(page.locator('.round-dots [data-done=true]')).to_have_count(1)
            native_camera(page, tree)
            expect(page.locator('.tree-node[data-node-id=purpose] use')).to_have_attribute('href', '#tree-flower')
            if width > 720:
                assert same_centre(origin, hit.bounding_box()), (origin, hit.bounding_box())
            page.screenshot(path=str(out / f'{label}-02-bloom.png'))
            open_flower(page, 'purpose')
            answer_layout(page, 'purpose')
            expect(page.locator('#node-body .answer')).to_have_text('及时通知活动变化')
            expect(page.locator('#node-dialog input,#node-dialog textarea')).to_have_count(0)
            page.keyboard.press('Escape')
            expect(page.locator('.tree-node[data-node-id=purpose]')).to_be_focused()
            page.locator('[data-tree-zoom="in"]').click()
            native_camera(page, tree, 1.3)
            open_flower(page, 'purpose')
            native_camera(page, tree, 1.3)
            page.get_by_role('button', name='关闭', exact=True).click()
            native_camera(page, tree, 1.3)
            page.set_viewport_size({'width': width + 20, 'height': height})
            native_camera(page, tree, 1.3)
            page.set_viewport_size({'width': width, 'height': height})
            page.locator('[data-tree-zoom="fit"]').click()
            native_camera(page, tree)
            open_flower(page, 'audience')
            expect(page.locator('.previous-answer .previous-excerpt')).to_have_text('及时通知活动变化')
            page.get_by_label('一个固定读书会', exact=True).click()
            asking(page, 'privacy')
            page.get_by_role('textbox').fill('只留名字和联系方式。')
            if label == 'mobile':
                page.set_viewport_size({'width': 390, 'height': 540})
                answer_layout(page, 'privacy')
                expect(page.get_by_role('textbox')).to_have_value('只留名字和联系方式。')
            confirm(page)
            asking(page, 'scope')
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(3)
            assert service.file.read_bytes() == source
            page.close()
        report['checks'].append('Desktop bubble and mobile sheet switch at 720 px. The mascot follows the active bud, the card leaves the bud visible, and keyboard choice advances and updates progress. Escape restores node focus. Zoom and the camera frame survive opening and resizing.')
    finally:
        service.close()


def long_content_layout(browser, out, report):
    questions = [
        node('long-question', '如果读书会临时取消，而且有参与者已经在路上、有人还没看到通知，这时第一版的报名页面应该先提供哪一种处理方式？',
             options=[{'id': 'contact', 'label': '请组织者逐一联系'}, {'id': 'notice', 'label': '先在页面发布通知'}]),
        node('many-options', '活动信息可以通过哪些渠道送达？', options=[
            {'id': 'mail', 'label': '发送邮件给报名时留下邮件地址的所有参与者'},
            {'id': 'inbox', 'label': '在站内消息里提醒参与者，并保留他们可以回看的历史记录'},
            {'id': 'sms', 'label': '发送手机短信给正在出发的参与者，提醒他们不要跑空'},
            {'id': 'group', 'label': '在读书会的群里发置顶公告，让群成员也能转发给同伴'},
            {'id': 'none', 'label': '都不需要', 'exclusive': True}
        ])
    ]
    questions[1]['input'] = 'multi_choice'
    service = Service(out / 'long-content-runtime', seed(questions))
    try:
        source = service.file.read_bytes()
        for width, height, label in [(1440, 1000, 'desktop'), (320, 600, 'mobile-narrow')]:
            page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            try:
                page.goto(service.url)
                for question in questions:
                    id = question['id']
                    open_flower(page, id)
                    expect(page.locator('#node-dialog #node-question')).to_have_text(question['question'])
                    answer_layout(page, id)
                    selected = question['options'][:2] if question['input'] == 'multi_choice' else []
                    for option in selected:
                        page.get_by_label(option['label'], exact=True).check()
                    field = page.get_by_placeholder('想补充就写这儿，可不填')
                    expect(field).to_be_visible()
                    start_height = field.bounding_box()['height']
                    note = '  ' + id + ' 的补充原话\n<保留内容，不改写>  '
                    field.fill(note)
                    assert field.bounding_box()['height'] > start_height
                    page.keyboard.press('Escape')
                    expect(page.locator('#node-dialog')).to_be_hidden()
                    open_flower(page, id)
                    for option in selected:
                        expect(page.get_by_label(option['label'], exact=True)).to_be_checked()
                    expect(field).to_have_value(note)
                    expect(page.locator(f'.tree-node[data-node-id="{id}"]')).to_have_attribute('data-status', 'pending')
                    no_overflow(page)
                    if label == 'mobile-narrow' and selected:
                        dialog = page.locator('#node-dialog')
                        assert dialog.evaluate('e => e.scrollHeight > e.clientHeight && e.scrollWidth <= e.clientWidth')
                        page.locator('#confirm-answer').scroll_into_view_if_needed()
                        assert dialog.evaluate('e => e.scrollTop > 0') and page.evaluate('scrollY') == 0
                    page.screenshot(path=str(out / f'{label}-{id}-retained.png'))
                    assert service.file.read_bytes() == source
            finally:
                page.close()
        report['checks'].append('Long headings and choices stay in the answer surface. The optional field grows with its text, closing preserves unconfirmed input, and a narrow sheet scrolls internally.')
    finally:
        service.close()


def preview_specimen(work):
    # Mirrors scripts/preview.mjs. The tree shape follows session_id: with this one, at
    # 1440x900 the old placement squeezed the privacy bubble to 175 of its 258 px.
    questions = [
        node('purpose', '这次报名页，最核心先解决哪件事？', options=[{'id':'signup','label':'让报名有一个统一入口'},{'id':'notice','label':'及时通知活动变更与状态'}]),
        node('audience', '第一批先开放给谁用？', options=[{'id':'club','label':'固定读书会老成员'},{'id':'open','label':'任何有兴趣的新读者'}]),
        node('channels', '活动有变动时，首版支持哪些通知渠道？', options=[{'id':'mail','label':'邮件通知'},{'id':'inbox','label':'站内私信'},{'id':'sms','label':'短信提醒'},{'id':'none','label':'都不需要','exclusive':True}]),
        node('privacy', '报名时，哪些信息真的需要留下？')]
    for n, why in zip(questions, ['界定应用范围与核心诉求。', '明确首批用户的准入门槛。', '确定消息触达的技术集成范围。', '明确必要字段与隐私边界。']):
        n['rationale'] = why
    questions[1].update(status='answered', answer={'option_ids':[], 'text':'', 'deferred':True})
    questions[2]['input'] = 'multi_choice'
    tree = seed(questions)
    tree.update(session_id='synthetic-bubble-fit-7', topic='读书会报名 · 气泡完整显示（示例）')
    return Service(work, tree)


def whole_bubble(page):
    dialog = page.locator('#node-dialog')
    sizes = dialog.evaluate('e => ({content: e.scrollHeight, shown: e.clientHeight, placement: e.dataset.placement})')
    assert sizes['content'] <= sizes['shown'] + 1, sizes
    box = dialog.bounding_box()
    assert box['y'] >= 0 and box['y'] + box['height'] <= page.viewport_size['height'] + 1, box


def bubble_fits_and_resumes(browser, out, report):
    service = preview_specimen(out / 'preview-runtime')
    try:
        for width, height in [(1280, 720), (1440, 900), (1920, 1080)]:
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            try:
                page.goto(service.url)
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false', timeout=20000)
                for id in ['purpose', 'audience', 'channels', 'privacy']:
                    open_flower(page, id)
                    whole_bubble(page)
                    page.screenshot(path=str(out / f'fit-{width}x{height}-{id}.png'))
                    page.keyboard.press('Escape')
                    expect(page.locator('#node-dialog')).to_be_hidden()
                no_overflow(page)
            finally:
                page.close()

        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda e: report['errors'].append(str(e)))
        try:
            page.goto(service.url)
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false', timeout=20000)
            asking(page, 'purpose')
            page.get_by_label('让报名有一个统一入口', exact=True).click()
            asking(page, 'channels')
            page.get_by_label('邮件通知', exact=True).check()
            # Reading an answered flower, then ×, picks the unfinished question back up.
            open_flower(page, 'purpose')
            expect(page.locator('#node-body .answer')).to_have_text('让报名有一个统一入口')
            page.get_by_role('button', name='关闭', exact=True).click()
            asking(page, 'channels')
            whole_bubble(page)
            expect(page.get_by_label('邮件通知', exact=True)).to_be_checked()
            # Escape is still a plain close that returns focus to the flower.
            open_flower(page, 'purpose')
            page.keyboard.press('Escape')
            expect(page.locator('#node-dialog')).to_be_hidden()
            expect(page.locator('.tree-node[data-node-id=purpose]')).to_be_focused()
            # × on the question being answered closes it and stays closed.
            open_flower(page, 'channels')
            page.get_by_role('button', name='关闭', exact=True).click()
            expect(page.locator('#node-dialog')).to_be_hidden()
            page.wait_for_timeout(800)
            expect(page.locator('#node-dialog')).to_be_hidden()
        finally:
            page.close()
        report['checks'].append('Desktop bubbles never squeeze a question behind a scrollbar at 1280x720, 1440x900 or 1920x1080. Closing a read-only flower with × resumes the unfinished question with its unconfirmed choice; Escape and × on the open question still just close.')
    finally:
        service.close()


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
            page.add_init_script('''window.blooms=[];window.flights=[];
              const original=Element.prototype.animate;
              Element.prototype.animate=function(frames,options){
                if(this.matches?.('.tree-symbol'))window.blooms.push({id:this.parentElement.dataset.nodeId,duration:options.duration});
                if(this.id==='mascot')window.flights.push(this.dataset.nodeId);
                return original.call(this,frames,options)
              };''')
            page.goto(service.url);page.wait_for_load_state('networkidle')
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=20000)
            asking(page, 'capacity')
            expect(page.locator('#card input,#card textarea')).to_have_count(0)
            expect(page.locator('.tree-node[data-status=pending]')).to_have_count(5)
            expect(page.locator('#tree-bud circle')).to_have_count(0)
            expect(page.locator('#tree-bud path')).to_have_count(5)
            expect(page.locator('.tree-node.is-current')).to_have_attribute('data-node-id', 'capacity')
            for bud in page.locator('.tree-node[data-status=pending]').all():
                expect(bud.locator('use')).to_be_visible()
                box=bud.locator('use').bounding_box();assert box['width']>5 and box['height']>6,box
            frame=page.locator('#tree-canvas').get_attribute('viewBox')
            geometry = page.locator('.tree-branch').evaluate_all('a=>a.map(n=>n.getAttribute("d"))')
            source = service.file.read_bytes()
            page.screenshot(path=str(out/'01-tree.png'))

            assert page.locator('#tree-canvas').get_attribute('viewBox')==frame
            answer_layout(page, 'capacity')
            expect(page.locator('.previous-answer blockquote')).to_be_hidden()
            page.locator('.previous-answer summary').click();expect(page.locator('.previous-answer blockquote')).to_be_visible();page.locator('.previous-answer summary').click()
            expect(page.locator('.previous-answer blockquote')).to_have_text('先让报名和取消有个统一入口。')
            expect(page.locator('input:checked')).to_have_count(0)
            expect(page.locator('#confirm-answer')).to_have_count(0)
            expect(page.locator('.question-reason p')).to_be_hidden()
            page.screenshot(path=str(out/'02-question.png'))
            page.get_by_label('先通知，等对方确认',exact=True).click()
            answer_layout(page, 'channels')
            expect(page.locator('.tree-node[data-node-id=capacity] use')).to_have_attribute('href','#tree-flower')
            assert any(a['id']=='capacity' and a['duration']==520 for a in page.evaluate('window.blooms'))
            assert 'channels' in page.evaluate('window.flights')
            for box in page.get_by_role('checkbox').all():expect(box).not_to_be_checked()
            expect(page.locator('.recommendation-info .w')).to_be_hidden()
            page.get_by_label('邮件通知',exact=True).check();page.get_by_label('站内通知',exact=True).check();confirm(page)

            open_flower(page,'capacity')
            expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            expect(page.locator('#node-dialog input,#node-dialog textarea')).to_have_count(0)
            expect(page.locator('#node-body .answer')).to_have_text('先通知，等对方确认')
            page.get_by_role('button',name='改',exact=True).click()
            expect(page.locator('.tree-node[data-node-id=capacity]')).to_have_attribute('data-status','answered')
            page.get_by_label('按候补顺序自动递补',exact=True).click()
            open_flower(page,'capacity');expect(page.locator('#node-body .answer')).to_have_text('按候补顺序自动递补')
            page.screenshot(path=str(out/'03-readback.png'))
            open_flower(page,'delete');page.get_by_role('textbox').fill('活动结束七天后删除。')
            open_flower(page,'delete');expect(page.get_by_role('textbox')).to_have_value('活动结束七天后删除。');confirm(page)
            asking(page,'export');page.get_by_label('先在页面查看',exact=True).click()
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(4)
            asking(page,'success');page.get_by_role('textbox').fill('  显示报名成功\n保留原话 <不改写>  ')
            open_flower(page,'capacity');expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            open_flower(page,'success');expect(page.get_by_role('textbox')).to_have_value('  显示报名成功\n保留原话 <不改写>  ')
            confirm(page)
            expect(page.locator('.tree-node[data-local=true]')).to_have_count(5)
            expect(page.locator('#node-dialog')).to_be_hidden()
            open_flower(page,'capacity',edit=True)
            page.get_by_label('按候补顺序自动递补',exact=True).click()
            assert service.file.read_bytes()==source
            assert geometry==page.locator('.tree-branch').evaluate_all('a=>a.map(n=>n.getAttribute("d"))')
            page.get_by_role('button',name='等等，我再看看',exact=True).click()
            report['checks'].append('Five consecutive answers; readonly readback; explicit draft edit; another two answers; note switching retains unconfirmed input; original bloom animation and branch geometry retained.')
            spoken_bud_layout(browser,out,report)
            long_content_layout(browser,out,report)
            bubble_fits_and_resumes(browser,out,report)
            expect(page.locator('.summary-list li')).to_have_count(5)
            page.get_by_role('button',name='交给 AI',exact=True).click()
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
            page.get_by_role('button',name='好了',exact=True).click()
            expect(page.locator('#message')).to_contain_text('revision changed')
            expect(page.get_by_role('textbox')).to_have_value('取消后不要自动通知，先由组织者联系。')
            assert service.state()['nodes'][0]['answer']['text']=='先让报名和取消有个统一入口。'
            confirm(page)
            open_flower(page,'capacity')
            expect(page.locator('#node-dialog')).to_have_attribute('data-mode','read')
            page.get_by_role('button',name='仍然有效',exact=True).click()
            open_flower(page,'channels',edit=True)
            expect(page.locator('#confirm-answer')).to_be_disabled() # Its direct parent is still yellow.
            page.locator('.recommendation-info > summary').click()
            expect(page.locator('.recommendation-info')).to_contain_text('旧推荐已隐藏')
            expect(page.locator('.recommendation-badge')).to_have_count(0)
            page.screenshot(path=str(out/'04-yellow-review.png'))
            open_flower(page,'notice');page.get_by_role('button',name='仍然有效',exact=True).click()
            asking(page,'channels')
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
            asking(page,'last')
            page.reload();asking(page,'last')
            page.emulate_media(reduced_motion='reduce')
            flights = page.evaluate('window.flights.length')
            open_flower(page, 'goal')
            answer_layout(page, 'goal')
            assert page.evaluate('window.flights.length') == flights
            assert page.locator('#node-dialog').evaluate('e => e.getAnimations().length') == 0
            report['checks'].append('New rounds and reloads open the current bud. Reduced motion skips the flight and bubble animation.')
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
