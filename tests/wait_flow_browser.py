"""Controlled regression for long waits, protocol leakage and real per-chapter navigation.
Virtual waits are UI evidence, never model latency measurements.
"""
import argparse, json, subprocess, time, re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_acceptance import Service, seed, node, request, no_overflow

BASE=Path(__file__).resolve().parents[1]

def run(work):
    work.mkdir(parents=True,exist_ok=True)
    report={'kind':'controlled browser/API regression, virtual waits; no model speed claim','checks':{},'errors':[],'screenshots':[]}
    service=Service(work/'runtime',seed([node('A','这次的使用目标？'),node('B','必须保留什么？')]))
    def post(path,data):
        code,result=request(service.url,path,data);assert code==200,(code,result);return result
    def control(action,**kwargs):return post('/document/control',{'action':action,'expected_revision':service.state()['revision'],**kwargs})
    def snap(page,name):
        file=work/(name+'.png');page.screenshot(path=str(file),full_page=True);report['screenshots'].append(file.name)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1440,'height':900},reduced_motion='reduce')
            page.on('pageerror',lambda error:report['errors'].append(str(error)))
            page.clock.install();page.route('**/document/status',lambda route:route.fulfill(status=200,content_type='text/event-stream',body='event: message\ndata: {"stream":"raw"}'))
            # Deliberate reconnect traffic has no idle network; wait for the visible recovery state instead.
            page.goto(service.url,wait_until='domcontentloaded');expect(page.locator('#card')).to_contain_text('生长中');expect(page.locator('#connection')).to_contain_text('重连');assert 'event:' not in page.locator('body').inner_text();page.unroute('**/document/status');page.clock.fast_forward(1500)
            expect(page.locator('#card .k').first).to_have_text('第 1 轮 · 本轮第 1 题，共 2 题')
            for text in ['持续可见的等待反馈','全部原文与 revision 守卫']:
                page.get_by_role('textbox').fill(text);page.get_by_role('button',name='确认并下一题',exact=True).click()
            raw='event: message\ndata: '+json.dumps({'content':'x'*3000})
            page.route('**/submit',lambda route:route.fulfill(status=502,content_type='text/event-stream',body=raw))
            page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.locator('#message')).to_contain_text('返回格式异常')
            assert 'event:' not in page.locator('body').inner_text() and 'data:' not in page.locator('body').inner_text()
            assert len(page.locator('#message').inner_text())<200;no_overflow(page);page.unroute('**/submit')
            page.get_by_role('button',name='提交本轮答案',exact=True).click()
            expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible();expect(page.locator('#card')).to_contain_text('生长中')
            page.clock.fast_forward(61000);expect(page.locator('#wait-elapsed')).to_contain_text('61 秒');expect(page.locator('#long-wait')).to_be_visible();snap(page,'wait-61s')
            since=page.locator('#wait-elapsed').get_attribute('data-since');page.route('**/state',lambda route:route.abort());page.clock.fast_forward(10000);page.wait_for_timeout(1200);expect(page.locator('#connection')).to_contain_text('重连');expect(page.locator('#card')).to_be_visible();page.unroute('**/state');page.clock.fast_forward(2000);page.wait_for_timeout(1200)
            assert page.locator('#wait-elapsed').get_attribute('data-since')==since;report['checks']['SSE_submit_is_safe_drafts_retry_and_reconnect_timer']=True
            revision=service.state()['revision'];post('/round',{'round':2,'expected_revision':revision,'nodes':[node('C','追问这项约束如何验证？',deps=['A'],round=2)]})
            page.clock.fast_forward(1500);expect(page.get_by_role('heading',name='追问这项约束如何验证？',exact=True)).to_be_visible();expect(page.locator('#card .k').first).to_have_text('第 2 轮 · 本轮第 1 题，共 1 题')
            page.get_by_role('textbox').fill('实际点击、截图，并保留计时证据');page.get_by_role('button',name='确认并下一题',exact=True).click();page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.locator('#card')).to_contain_text('生长中')
            page.locator('.tree-node[data-node-id="A"]').click();page.get_by_role('button',name='修改回答',exact=True).click();expect(page.locator('#card')).to_contain_text('需复核')
            page.get_by_role('textbox').fill('黄叶复核之后也要持续显示等待');page.get_by_role('button',name='保存并确认此题',exact=True).click();expect(page.get_by_role('heading',name='追问这项约束如何验证？',exact=True)).to_be_visible();page.get_by_role('button',name='仍然有效',exact=True).click()
            expect(page.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible();page.clock.fast_forward(168000);expect(page.locator('#wait-elapsed')).to_contain_text('168 秒');expect(page.locator('#card')).to_contain_text('生长中');expect(page.locator('#long-wait')).to_be_visible();snap(page,'review-exit-168s')
            report['checks']['last_yellow_leaf_enters_visible_wait_168s']=True
            before=service.file.read_bytes();code,_=request(service.url,'/round',{'round':3,'expected_revision':service.state()['revision'],'nodes':[]});assert code==400 and before==service.file.read_bytes()
            control('offer');page.clock.fast_forward(1500);expect(page.get_by_role('button',name='保存并生成任务文档',exact=True)).to_be_visible();assert service.state()['current_round']==2
            page.get_by_role('button',name='保存并生成任务文档',exact=True).click();expect(page.get_by_role('heading',name='正在生成任务文档…',exact=True)).to_be_visible();status=request(service.url,'/document/status')[1];control('claim',job_id=status['job_id']);page.clock.fast_forward(4000)
            fruits=page.locator('.tree-fruit');expect(fruits).to_have_count(2);expect(fruits.first).to_have_attribute('data-availability','generating');expect(fruits.first).to_have_attribute('aria-label',re.compile('章节生成中'))
            box=fruits.first.bounding_box();page.mouse.click(box['x']+box['width']/2,box['y']+box['height']/2);expect(page.locator('#message')).to_contain_text('这个章节还在生成');assert len(browser.contexts[0].pages)==1
            page.clock.fast_forward(420000);expect(page.locator('#wait-elapsed')).to_contain_text(re.compile('42[0-9] 秒'));expect(page.locator('#card')).to_contain_text('生长中');snap(page,'document-420s')
            since=page.locator('#wait-elapsed').get_attribute('data-since');control('progress',job_id=status['job_id'],stage='checking');page.clock.fast_forward(1200);expect(page.locator('#card')).to_contain_text('正在校验');assert page.locator('#wait-elapsed').get_attribute('data-since')==since
            status=request(service.url,'/document/status')[1];context=work/'status.json';context.write_text(json.dumps(status,ensure_ascii=False),encoding='utf-8');parts=work/'parts';parts.mkdir(exist_ok=True)
            def part(view,html,**extra):return {'source':{key:status['source'][key] for key in ['session_id','revision','digest']}|{'job_id':status['job_id']},'view':view,'html':html,**extra}
            first=status['source']['chapters'][0];(parts/'chapter-a.json').write_text(json.dumps(part('chapter','<p>这个主题已经完成，可以先阅读。</p>',chapter_id=first['id'],title='先完成的主题'),ensure_ascii=False),encoding='utf-8')
            def assemble(preview):
                cmd=['node',str(BASE/'scripts/compose-document.mjs'),'--context',str(context),'--tree',str(service.file),'--parts',str(parts)]
                if preview:cmd+=['--preview','--url',service.url]
                result=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8');assert result.returncode==0,result.stderr;return json.loads(result.stdout)
            report['preview_assembly']=assemble(True);page.clock.fast_forward(1500);expect(page.locator('.tree-fruit[data-fruit-id="A"]')).to_have_attribute('data-availability','ready');expect(page.locator('.tree-fruit[data-fruit-id="B"]')).to_have_attribute('data-availability','generating');expect(page.locator('#card')).to_contain_text('已完成 1 / 2 章')
            with page.expect_popup() as popup:page.locator('.tree-fruit[data-fruit-id="A"]').click()
            chapter=popup.value;chapter.wait_for_load_state('networkidle');expect(chapter.locator('#'+first['anchor'])).to_contain_text('这个主题已经完成');assert 'chapter=A' in chapter.url;assert chapter.evaluate('document.querySelector("#'+first['anchor']+'").getBoundingClientRect().top')<chapter.viewport_size['height'];snap(chapter,'first-chapter-readable');chapter.close();snap(page,'one-ripe-fruit')
            report['checks']['unripe_is_labeled_and_completed_chapter_opens_immediately']=True
            # A raw failure status is filtered both in the bridge and the browser; ready chapters remain readable.
            control('failed',job_id=status['job_id'],error=raw);page.clock.fast_forward(1500);expect(page.get_by_role('button',name='重试生成文档',exact=True)).to_be_visible();assert 'event:' not in page.locator('body').inner_text();assert len(page.locator('#card').inner_text())<1100
            for width,height in [(1440,900),(390,844)]:page.set_viewport_size({'width':width,'height':height});no_overflow(page);assert page.locator('#card').evaluate('n=>n.scrollWidth<=n.clientWidth');snap(page,'safe-failure-'+str(width))
            report['checks']['failed_document_has_safe_message_no_overflow_at_two_widths']=True
            page.get_by_role('button',name='重试生成文档',exact=True).click();status=request(service.url,'/document/status')[1];control('claim',job_id=status['job_id']);context.write_text(json.dumps(status,ensure_ascii=False),encoding='utf-8')
            (parts/'chapter-a.json').unlink() # The retry uses only the new job's independent pieces.
            for c in status['source']['chapters']:(parts/('root-'+c['id']+'.json')).write_text(json.dumps(part('chapter','<p>正式章节内容</p>',chapter_id=c['id']),ensure_ascii=False),encoding='utf-8')
            for name,html in [('design','<article id="R1" data-kind="requirement"><h3>需求</h3><p>持续等待</p></article>'),('plan','<article id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1"><h3>开发项</h3><span data-field="status">planned</span><a href="#AC1">验收</a></article>'),('acceptance','<article id="AC1" data-kind="criterion" data-requirements="R1"><h3>验收</h3><span data-field="status">unverified</span><a href="#R1">需求</a></article>')]:
                (parts/(name+'.json')).write_text(json.dumps(part(name,html),ensure_ascii=False),encoding='utf-8')
            report['final_assembly']=assemble(False);control('ready',job_id=status['job_id']);page.clock.fast_forward(1500);expect(page.get_by_role('link',name='打开完整任务文档',exact=True)).to_be_visible();expect(page.locator('#meta')).to_contain_text('共完成 2 轮');assert '第 3 轮' not in page.locator('#meta').inner_text();assert all(n['status']=='answered' for n in service.state()['nodes'])
            with page.expect_popup() as popup:page.locator('.tree-fruit[data-fruit-id="B"]').click()
            final=popup.value;final.wait_for_load_state('networkidle');expect(final.get_by_role('tab')).to_have_count(3);final.get_by_role('tab',name='开发清单',exact=True).click();expect(final.locator('#W1')).to_be_visible();final.close()
            snap(page,'completed');report['checks']['retry_final_assembly_three_tabs_and_real_round_number']=True
            report['checks']['all_original_answers_unchanged_on_document_retry']=service.state()['nodes'][0]['answer']['text']=='黄叶复核之后也要持续显示等待'
            report['checks']['bad_stream_at_initial_load_keeps_card_and_recovers']=True
            browser.close()
        assert not report['errors'],report['errors'];report['status']='passed'
    except Exception as error:
        report['status']='failed';report['failure']=str(error);raise
    finally:
        service.close();(work/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);args=parser.parse_args();print(json.dumps(run(args.work),ensure_ascii=False,indent=2))
