"""AI-query silence and recovery using real check.mjs calls, not model timing."""
import argparse,json,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_acceptance import Service,seed,node,request,no_overflow,ai_check

BASE=Path(__file__).resolve().parents[1]
PAUSED='AI 对话好像已暂停。请回到聊天窗口发一句「继续」，或点「复制提醒」粘贴过去。你的答案已保存，不会丢。'

def run(work):
    work.mkdir(parents=True,exist_ok=True)
    report={'kind':'controlled UI/API; actual 30-second query silence, no AI model invocation','checks':{},'errors':[]}
    thinking=Service(work/'thinking',seed([node('A','已确认的需求',answered=True)]))
    queued=Service(work/'queued',seed([node('A','等待写入文档的需求',answered=True)]))
    def control(action,**extra):
        code,result=request(queued.url,'/document/control',{'action':action,'expected_revision':queued.state()['revision'],**extra});assert code==200,(code,result);return result
    try:
        control('offer');job=control('save')['job_id']
        originals=[s.file.read_bytes() for s in [thinking,queued]]
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            pages=[];since=[]
            for s,width in [(thinking,1440),(queued,390)]:
                page=browser.new_page(viewport={'width':width,'height':900},reduced_motion='reduce');pages.append(page)
                page.on('pageerror',lambda error:report['errors'].append(str(error)))
                page.goto(s.url);page.wait_for_load_state('networkidle')
                expect(page.get_by_role('heading',name='等待 AI 对话连接',exact=True)).to_be_visible()
                expect(page.locator('#copy-reminder')).not_to_have_class('small-action needs-attention')
                assert PAUSED not in page.locator('#card').inner_text();assert '生长中' not in page.locator('#card').inner_text()
                assert request(s.url,'/progress')[1]['ai']['last_check_at'] is None
                since.append(page.locator('#wait-elapsed').get_attribute('data-since'))
                no_overflow(page)
            report['checks']['never_queried_shows_connecting_in_thinking_and_queued']=True
            for s,page,title in zip([thinking,queued],pages,['正在想下一轮的问题…','正在生成任务文档…']):
                ai_check(s);expect(page.get_by_role('heading',name=title,exact=True)).to_be_visible()
            # Neither page's continuing GET polling is allowed to renew the assistant receipt.
            expect(pages[0].locator('#ai-wait-notice')).to_have_text(PAUSED,timeout=36000)
            expect(pages[1].locator('#ai-wait-notice')).to_have_text(PAUSED,timeout=5000)
            report['silence_seconds']={}
            for label,s,page in zip(['thinking','queued'],[thinking,queued],pages):
                age=request(s.url,'/progress')[1]['ai']['seconds_since_last_check'];assert age>30;report['silence_seconds'][label]=age
                expect(page.locator('#copy-reminder')).to_have_class('small-action needs-attention')
                expect(page.locator('#copy-reminder')).to_have_attribute('aria-describedby','ai-wait-notice')
                text=page.locator('#card').inner_text();assert '生长中' not in text and '还在想' not in text
                no_overflow(page);page.screenshot(path=str(work/(label+'-paused.png')),full_page=True)
            report['checks']['silence_over_30s_pauses_both_states_and_highlights_reminder']=True
            pages[0].evaluate('navigator.clipboard.writeText=async text=>{window.copiedReminder=text}')
            pages[0].get_by_role('button',name='复制提醒',exact=True).click()
            copied=pages[0].evaluate('window.copiedReminder');identity=json.loads(copied.split('\n')[-1])
            assert set(identity)=={'session_id','current_round','url'} and identity['session_id']==thinking.state()['session_id']
            assert thinking.state()['nodes'][0]['answer']['text'] not in copied
            report['checks']['highlighted_copy_reminder_still_contains_only_locator_fields']=True
            fresh=browser.new_page(reduced_motion='reduce');fresh.clock.install();fresh.goto(thinking.url);fresh.wait_for_load_state('networkidle')
            expect(fresh.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
            assert PAUSED not in fresh.locator('#card').inner_text()
            fresh.clock.fast_forward(31000);expect(fresh.locator('#ai-wait-notice')).to_have_text(PAUSED);fresh.close()
            report['checks']['fresh_page_grace_prevents_immediate_stale_timestamp_alarm']=True
            for index,(s,page,title) in enumerate(zip([thinking,queued],pages,['正在想下一轮的问题…','正在生成任务文档…'])):
                ai_check(s);expect(page.get_by_role('heading',name=title,exact=True)).to_be_visible()
                expect(page.locator('#ai-wait-notice')).to_have_count(0)
                expect(page.locator('#copy-reminder')).to_have_class('small-action')
                assert page.locator('#wait-elapsed').get_attribute('data-since')==since[index]
                assert s.file.read_bytes()==originals[index]
            report['checks']['resumed_checks_clear_warning_without_resetting_wait_or_answers']=True
            # A stale receipt must not label an actively claimed document as paused.
            def stale_projection(route):
                response=route.fetch();data=response.json();data['ai']['seconds_since_last_check']=31
                route.fulfill(response=response,json=data)
            pages[1].route('**/progress',stale_projection);control('claim',job_id=job)
            expect(pages[1].locator('#card')).to_contain_text('正在整理三个视图')
            pages[1].wait_for_timeout(1200);expect(pages[1].locator('#ai-wait-notice')).to_have_count(0)
            report['checks']['claimed_document_is_not_treated_as_queued_even_with_stale_receipt']=True
            # Restart the same state file on the same URL; do not recreate or write the tree.
            old_instance=thinking.startup['instance_id'];port=thinking.startup['port'];thinking.close()
            thinking.child=subprocess.Popen(['node',str(BASE/'scripts/server.mjs'),'--state',str(thinking.file),'--port',str(port),'--wait-ms','150'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
            thinking.startup=json.loads(thinking.child.stdout.readline());assert thinking.startup['instance_id']!=old_instance
            assert thinking.startup['url']==thinking.url and thinking.file.read_bytes()==originals[0]
            expect(pages[0].get_by_role('heading',name='等待 AI 对话连接',exact=True)).to_be_visible()
            assert request(thinking.url,'/progress')[1]['ai']['last_check_at'] is None
            assert PAUSED not in pages[0].locator('#card').inner_text()
            ai_check(thinking);expect(pages[0].get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
            assert thinking.file.read_bytes()==originals[0]
            report['checks']['same_url_restart_clears_receipt_then_reconnects_without_rewriting_tree']=True
            pages[0].route('**/progress',stale_projection)
            code,_=request(thinking.url,'/round',{'expected_revision':thinking.state()['revision'],'round':2,'nodes':[node('B','用户待答的下一题',deps=['A'],round=2)]});assert code==200
            expect(pages[0].get_by_role('heading',name='用户待答的下一题',exact=True)).to_be_visible();expect(pages[0].locator('#ai-wait-notice')).to_have_count(0)
            report['checks']['pending_human_question_does_not_show_ai_pause']=True
            browser.close()
        assert not report['errors'],report['errors'];report['status']='passed'
    except Exception as error:
        report['status']='failed';report['failure']=str(error);raise
    finally:
        thinking.close();queued.close();(work/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);args=parser.parse_args();print(json.dumps(run(args.work),ensure_ascii=False,indent=2))
