"""Real Chromium actors and controlled UI checks. Only the calling Codex authors AI rounds."""
import argparse, json, subprocess, time, uuid, sys, urllib.request, urllib.error, hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
sys.stdout.reconfigure(encoding='utf-8')
BASE=Path(__file__).resolve().parents[1]

def request(url,path,body=None):
    if body is not None:
        with urllib.request.urlopen(url+'/state',timeout=3) as response:identity=json.loads(response.read())['session_id']
        body={'expected_session_id':identity,**body}
    data=None if body is None else json.dumps(body,ensure_ascii=False).encode('utf-8')
    req=urllib.request.Request(url+path,data=data,headers={} if body is None else {'content-type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=35) as response:return response.status,json.loads(response.read())
    except urllib.error.HTTPError as error:return error.code,json.loads(error.read())

def node(id,question=None,deps=None,round=1,answered=False,options=None):
    return {'id':id,'question':question or id+' 的问题','rationale':'受控测试：验证此问题对应的决定及交互边界。','input':'single_choice' if options else 'text','options':options or [],'answer':{'option_ids':[],'text':id+' 原答案'} if answered else None,'depends_on':deps or [],'status':'answered' if answered else 'pending','round':round}

def seed(nodes,round=1):
    return {'schema_version':2,'session_id':'controlled-browser-'+uuid.uuid4().hex[:8],'topic':'受控页面验收','revision':0,'current_round':round,'status':'active','nodes':nodes}

class Service:
    def __init__(self,work,tree):
        self.work=work;work.mkdir(parents=True,exist_ok=True);self.file=work/'tree.json';self.file.write_text(json.dumps(tree,ensure_ascii=False),encoding='utf-8')
        self.child=subprocess.Popen(['node',str(BASE/'scripts/server.mjs'),'--state',str(self.file),'--wait-ms','150'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        line=self.child.stdout.readline()
        if not line:raise RuntimeError(self.child.stderr.read())
        self.startup=json.loads(line);self.url=self.startup['url']
    def state(self):return request(self.url,'/state')[1]
    def close(self):
        if self.child.poll() is None:self.child.terminate();self.child.wait(timeout=5)

def capture(page,out,name):
    page.screenshot(path=str(out/(name+'.png')),full_page=True)

def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'page horizontal overflow'

def document_fixture(status):
    import html
    source=status['source'];esc=html.escape
    sections=''.join('<article id="'+c['anchor']+'"><h2>'+esc(c['title'])+'</h2><p>受控文档链接测试</p></article>' for c in source['chapters'])
    attrs=' '.join('data-source-'+key+'="'+esc(str(value),quote=True)+'"' for key,value in [('session',source['session_id']),('revision',source['revision']),('digest',source['digest']),('job',status['job_id'])])
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><main data-task-record data-revision="controlled" '+attrs+'><section id="design-view">'+sections+'<article id="R1" data-kind="requirement">测试需求</article></section><section id="plan-view"><article data-kind="work" id="W1">测试任务</article></section><section id="acceptance-view"><article data-kind="criterion" id="AC1">测试验收</article></section></main></html>'

def run_suite(work,scenario='all',layout_fixture='v7'):
    work.mkdir(parents=True,exist_ok=True);report={'kind':'controlled UI and synthetic layout evidence','checks':{},'errors':[],'screenshots':[]}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        if scenario in ('all','interactions'):
            service=Service(work/'draft-submit',seed([node('choice','界面视觉以哪一版为准？',options=[{'id':'v7','label':'按 v7 的纸底与墨枝'},{'id':'other','label':'另一版'}]),node('text','本轮答案什么时候保存？'),node('extra','补充一个交互要求？')]))
            try:
                page=browser.new_page(viewport={'width':1440,'height':900});page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.clock.install();page.goto(service.url);page.wait_for_load_state('networkidle');expect(page.get_by_role('heading',name='界面视觉以哪一版为准？',exact=True)).to_be_visible();page.wait_for_timeout(1600)
                assert page.evaluate('getComputedStyle(document.body).backgroundColor')=='rgb(239, 233, 220)'
                assert page.locator('#tree-canvas text').count()==0
                capture(page,work,'opening');before=service.file.read_bytes()
                page.keyboard.press('1');page.keyboard.press('Enter');expect(page.locator('.tree-node[data-local=true]')).to_have_count(1);assert service.file.read_bytes()==before
                page.wait_for_timeout(550);capture(page,work,'local-bloom')
                area=page.get_by_label('本轮答案什么时候保存？',exact=True);area.fill('  ');expect(page.get_by_role('button',name='确认并下一题',exact=True)).to_be_disabled()
                area.fill('先汇总，再手动提交整轮。\n 保留这行空格 ');page.keyboard.press('Control+Enter')
                page.get_by_label('补充一个交互要求？',exact=True).fill('等待中可以修改。');page.get_by_role('button',name='确认并下一题',exact=True).click()
                expect(page.get_by_role('button',name='提交本轮答案',exact=True)).to_be_visible();assert service.file.read_bytes()==before
                page.locator('.summary-list button').first.click();expect(page.get_by_label('按 v7 的纸底与墨枝',exact=True)).to_be_checked();page.get_by_role('button',name='确认并下一题',exact=True).click()
                page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
                saved=service.state();assert saved['revision']==1;assert saved['nodes'][1]['answer']['text']=='先汇总，再手动提交整轮。\n 保留这行空格 '
                page.clock.fast_forward(61000);expect(page.locator('#long-wait')).to_be_visible();capture(page,work,'wait-over-60-seconds')
                frozen=service.file.read_bytes();page.route('**/state',lambda route:route.abort());expect(page.locator('#connection')).to_contain_text('断开',timeout=8000)
                page.unroute('**/state');expect(page.locator('#connection')).to_contain_text('已连接',timeout=8000);assert service.file.read_bytes()==frozen
                page.emulate_media(reduced_motion='reduce');page.wait_for_timeout(100);assert not page.locator('#tree-canvas').evaluate('n=>n.classList.contains("is-waiting")')
                for width,height,label in [(1000,900,'desktop-1000'),(390,844,'mobile')]:
                    page.set_viewport_size({'width':width,'height':height});no_overflow(page);capture(page,work,label)
                report['checks']['local_confirmation_summary_manual_submit_raw_text']=True
                report['checks']['wait_60_seconds_virtual_clock_no_auto_failure']=True
                report['checks']['disconnect_reconnect_preserves_saved_answers']=True
                report['checks']['keyboard_and_reduced_motion']=True
                page.close()
            finally:service.close()
        if scenario in ('all','review'):
            old=[node('A',deps=[],answered=True),node('B',deps=['A'],answered=True),node('C',deps=['B'],answered=True),node('D',answered=True),node('F',deps=['A','D'],answered=True)]
            service=Service(work/'review',seed(old+[node('X','无关的新题',round=2)],round=2))
            try:
                page=browser.new_page(viewport={'width':1440,'height':900});page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.goto(service.url);page.wait_for_load_state('networkidle');page.wait_for_timeout(1400)
                page.get_by_label('无关的新题',exact=True).fill('这份无关草稿应该保留')
                page.locator('.tree-node[data-node-id=A]').click();expect(page.locator('#node-dialog')).to_be_visible();page.keyboard.press('Escape');expect(page.locator('.tree-node[data-node-id=A]')).to_be_focused()
                page.locator('.tree-node[data-node-id=A]').click();page.get_by_role('button',name='修改回答',exact=True).click()
                expect(page.locator('.tree-node[data-status=needs_review]')).to_have_count(4)
                snap=service.state();assert [n['id'] for n in snap['nodes'] if n['status']=='needs_review']==['A','B','C','F'];assert snap['nodes'][3]['answer']['text']=='D 原答案'
                capture(page,work,'review-yellow')
                page.get_by_role('button',name='仍然有效',exact=True).click()
                page.get_by_label('B 的问题',exact=True).fill('上游再次修改前的草稿')
                now=service.state();assert request(service.url,'/decision',{'id':'A','expected_revision':now['revision'],'answer':{'option_ids':[],'text':'A 再次修改'}})[0]==200
                expect(page.get_by_label('B 的问题',exact=True)).to_have_value('B 原答案')
                page.get_by_role('button',name='仍然有效',exact=True).click();expect(page.locator('.tree-node[data-node-id=C]')).to_have_attribute('data-status','needs_review')
                page.get_by_role('button',name='仍然有效',exact=True).click();page.get_by_role('button',name='仍然有效',exact=True).click();expect(page.get_by_label('无关的新题',exact=True)).to_have_value('这份无关草稿应该保留')
                page.get_by_role('button',name='确认并下一题',exact=True).click();page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
                revision=service.state()['revision'];page.locator('.tree-node[data-node-id=A]').click();page.get_by_role('button',name='修改回答',exact=True).click();expect(page.locator('.tree-node[data-status=needs_review]')).to_have_count(4)
                before=service.file.read_bytes();code,_=request(service.url,'/round',{'round':3,'expected_revision':revision,'nodes':[node('late',deps=['A'],round=3)]});assert code==409 and service.file.read_bytes()==before
                assert page.get_by_role('button',name='保存并生成任务文档',exact=True).count()==0
                report['checks']['transitive_shared_review_and_explicit_reconfirmation']=True;report['checks']['unrelated_draft_preserved']=True;report['checks']['already_reviewing_downstream_draft_invalidated_on_upstream_change']=True;report['checks']['waiting_edit_rejects_stale_round']=True
                page.close()
            finally:service.close()
        if scenario in ('all','tree'):
            module=(BASE/'tests/fixtures.mjs').as_uri();factory='specimen28' if layout_fixture=='v7' else 'specimen28FourRounds';tree=json.loads(subprocess.check_output(['node','--input-type=module','-e','import {'+factory+'} from '+json.dumps(module)+';console.log(JSON.stringify('+factory+'()))'],text=True,encoding='utf-8'))
            tree['nodes'][11]['status']='needs_review';tree['nodes'][20]['status']='needs_review'
            service=Service(work/'specimen-28',tree)
            try:
                page=browser.new_page(viewport={'width':1440,'height':900});page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.goto(service.url);page.wait_for_load_state('networkidle');expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=25000);expect(page.locator('.tree-node')).to_have_count(28)
                assert page.locator('#tree-canvas text').count()==0;capture(page,work,'28-review-desktop')
                for width,height,label in [(1440,900,'desktop'),(1000,900,'compact'),(390,844,'mobile')]:
                    page.set_viewport_size({'width':width,'height':height});no_overflow(page)
                    for target in page.locator('.tree-node').all():
                        id=target.get_attribute('data-node-id');target.click();expect(page.locator('#node-question')).to_have_text(next(n['question'] for n in tree['nodes'] if n['id']==id));page.get_by_role('button',name='关闭',exact=True).click()
                    capture(page,work,'28-'+label)
                # A separate completed synthetic fixture validates fruit layout and document links, not writer authorship.
                page.close()
            finally:service.close()
            for n in tree['nodes']:n['status']='answered'
            tree['status']='complete';service=Service(work/'specimen-28-saved',tree)
            try:
                page=browser.new_page(viewport={'width':1440,'height':900});page.on('pageerror',lambda e:report['errors'].append(str(e)));page.goto(service.url);page.wait_for_load_state('networkidle')
                expect(page.get_by_role('button',name='重试生成文档',exact=True)).to_be_visible();page.get_by_role('button',name='重试生成文档',exact=True).click()
                for _ in range(30):
                    status=request(service.url,'/document/status')[1]
                    if status['phase']=='requested':break
                    time.sleep(.1)
                assert status['phase']=='requested';request(service.url,'/document/control',{'action':'claim','expected_revision':0,'job_id':status['job_id']})
                output=Path(service.startup['document_file']);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(document_fixture(status),encoding='utf-8')
                assert request(service.url,'/document/control',{'action':'ready','expected_revision':0,'job_id':status['job_id']})[0]==200
                expect(page.get_by_role('link',name='打开完整任务文档',exact=True)).to_be_visible();expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=25000)
                roots=len([n for n in tree['nodes'] if not n['depends_on']]);expect(page.locator('.tree-fruit')).to_have_count(roots)
                entities=page.locator('.tree-node .tree-symbol,.tree-fruit .fruit-body').evaluate_all('items=>items.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})')
                overlaps=[]
                for i,a in enumerate(entities):
                    for j,b in enumerate(entities[:i]):
                        if min(a['x']+a['w'],b['x']+b['w'])-max(a['x'],b['x'])>.4 and min(a['y']+a['h'],b['y']+b['h'])-max(a['y'],b['y'])>.4:overlaps.append([i,j])
                assert not overlaps,overlaps
                capture(page,work,'saved-fruits')
                for target in page.locator('.tree-fruit').all():
                    with page.expect_popup() as popup_info:target.click()
                    popup=popup_info.value;popup.wait_for_load_state();assert '#topic-' in popup.url;popup.close()
                page.set_viewport_size({'width':390,'height':844});no_overflow(page);capture(page,work,'saved-fruits-mobile')
                report['checks']['28_nodes_clickable_at_three_viewports']=True;report['checks']['28_no_entity_overlap_and_no_tree_labels']=True;report['checks']['fruit_count_matches_roots_and_chapter_links']=True
                report['synthetic_fruit_count']=roots
                page.close()
            finally:service.close()
        if scenario in ('all','tree'):
            deep=seed([node('depth'+str(i),deps=[] if i==0 else ['depth'+str(i-1)],round=i+1,answered=True) for i in range(8)],round=8);deep['status']='complete'
            service=Service(work/'deep-animation',deep)
            try:
                page=browser.new_page(viewport={'width':1000,'height':900});page.goto(service.url);expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false',timeout=25000)
                expect(page.locator('.tree-node[data-node-id=depth7]')).to_have_css('opacity','1')
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false')
                report['checks']['deepest_new_branch_finishes_before_animation_stops']=True;page.close()
            finally:service.close()
        browser.close()
    assert not report['errors'],report['errors'];report['status']='passed';report['screenshots']=[p.name for p in work.glob('*.png')]
    (work/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');return report

def run_actor(args):
    out=Path(args.evidence);out.mkdir(parents=True,exist_ok=True);nonce='银杏-'+uuid.uuid4().hex[:10];raw=f'预算 3000；本轮临时特征词：{nonce}\n自由回答原文："第一轮" <不改写>'
    report={'kind':'transport actor, synthetic answers; next round authored by calling Codex','checks':{},'errors':[],'feature_word':nonce}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1000,'height':900});page.on('pageerror',lambda e:report['errors'].append(str(e)));page.goto(args.url);page.wait_for_load_state('networkidle')
        if args.capture_only:
            for name,w,h in [('desktop',1000,900),('mobile',390,844)]:
                page.set_viewport_size({'width':w,'height':h});no_overflow(page);capture(page,out,args.label+'-'+name)
                if args.check_cards:assert page.locator('#card').is_visible() and page.locator('link[rel=stylesheet]').count()==1
            browser.close();return {'status':'passed','kind':'capture-only'}
        capture(page,out,'round-1');navigation=page.evaluate('performance.timeOrigin');page.get_by_label('先做网页版',exact=True).check();page.get_by_role('button',name='确认并下一题',exact=True).click();page.get_by_role('textbox').fill(raw);page.get_by_role('button',name='确认并下一题',exact=True).click();time.sleep(args.submit_delay)
        report['submitted_at_epoch']=time.time();page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible();print('BROWSER_SUBMITTED_ROUND_1',flush=True)
        expect(page.locator('#meta')).to_contain_text('第 2 轮',timeout=300000);assert navigation==page.evaluate('performance.timeOrigin');assert nonce in page.locator('#card').inner_text() and '3000' in page.locator('#card').inner_text()
        report['round2_visible_at_epoch']=time.time();report['submit_to_next_question_seconds']=report['round2_visible_at_epoch']-report['submitted_at_epoch'];capture(page,out,'new-branches')
        page.get_by_role('textbox').fill('确认，预算保持 3000；第二轮回传成功。');page.get_by_role('button',name='确认并下一题',exact=True).click();page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible();assert not report['errors'],report['errors'];report['checks']={'same_page':True,'unseen_feature_word_used_by_current_agent':True,'second_round_submitted':True};report['status']='passed';browser.close()
    (out/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');return report

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--evidence');parser.add_argument('--work');parser.add_argument('--scenario',choices=['all','interactions','review','tree'],default='all');parser.add_argument('--layout-fixture',choices=['v7','four'],default='v7');parser.add_argument('--submit-delay',type=float,default=3);parser.add_argument('--capture-only',action='store_true');parser.add_argument('--label',default='capture');parser.add_argument('--check-cards',action='store_true');parser.add_argument('--expected-history-count',type=int,default=2);args=parser.parse_args()
    if args.work:report=run_suite(Path(args.work),args.scenario,args.layout_fixture)
    elif args.url and args.evidence:report=run_actor(args)
    else:parser.error('use --work for the controlled suite, or --url and --evidence for current-conversation actor')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
