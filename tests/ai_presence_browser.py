"""AI-query silence and recovery using real check.mjs calls, not model timing."""
import argparse,json,subprocess,re,os,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_acceptance import Service,seed,node,request,no_overflow,ai_check

BASE=Path(__file__).resolve().parents[1]
PAUSED=re.compile(r'已 \d+ 秒没收到 AI 回应，回聊天窗口发"继续"')

def run(work):
    work.mkdir(parents=True,exist_ok=True)
    report={'kind':'controlled UI/API; actual 60-second query silence despite live heartbeats, no AI model invocation','checks':{},'errors':[]}
    heartbeats=[]
    thinking=Service(work/'thinking',seed([node('A','已确认的需求',answered=True)]))
    queued=Service(work/'queued',seed([node('A','等待写入文档的需求',answered=True)]))
    def start_heartbeat(service):
        heartbeat=json.loads(subprocess.check_output(['node',str(BASE/'scripts/check.mjs'),'--url',service.url,'--session',service.state()['session_id'],'--heartbeat'],text=True,encoding='utf-8'))
        assert heartbeat['owner_pid']==os.getpid() and heartbeat['lease_ms']==180000
        heartbeats.append(heartbeat);return heartbeat
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
                assert not PAUSED.search(page.locator('#card').inner_text());assert '生长中' not in page.locator('#card').inner_text()
                assert request(s.url,'/progress')[1]['ai']['last_check_at'] is None
                since.append(page.locator('#wait-elapsed').get_attribute('data-since'))
                no_overflow(page)
            report['checks']['never_queried_shows_connecting_in_thinking_and_queued']=True
            for s,page,title in zip([thinking,queued],pages,['正在想下一轮的问题…','正在生成任务文档…']):
                start_heartbeat(s);expect(page.get_by_role('heading',name='等待 AI 对话连接',exact=True)).to_be_visible()
                ai_check(s);expect(page.get_by_role('heading',name=title,exact=True)).to_be_visible()
            # Heartbeats continue every 10 seconds; neither they nor browser GETs may hide a silent assistant.
            expect(pages[0].locator('#ai-wait-notice')).to_have_text(PAUSED,timeout=67000)
            expect(pages[1].locator('#ai-wait-notice')).to_have_text(PAUSED,timeout=5000)
            report['silence_seconds']={}
            for label,s,page in zip(['thinking','queued'],[thinking,queued],pages):
                age=request(s.url,'/progress')[1]['ai']['seconds_since_last_check'];assert age>60;report['silence_seconds'][label]=age
                ai=request(s.url,'/progress')[1]['ai'];assert ai['heartbeat_active'] and ai['seconds_since_last_heartbeat']<12
                recovery=request(s.url,'/recovery')[1]['ai'];assert recovery['last_check_at']==ai['last_check_at'] and recovery['seconds_since_last_check']>60
                visible_age=int(re.search(r'已 (\d+) 秒',page.locator('#ai-wait-notice').inner_text()).group(1));assert abs(visible_age-age)<3
                expect(page.locator('#copy-reminder')).to_have_class('small-action needs-attention')
                expect(page.locator('#copy-reminder')).to_have_attribute('aria-describedby','ai-wait-notice')
                text=page.locator('#card').inner_text();assert '生长中' not in text and '还在想' not in text
                no_overflow(page);page.screenshot(path=str(work/(label+'-paused.png')),full_page=True)
            report['checks']['live_heartbeats_cannot_hide_60s_check_silence_in_thinking_and_queued']=True
            control('claim',job_id=job);expect(pages[1].locator('#ai-wait-notice')).to_have_text(PAUSED)
            expect(pages[1].locator('#heartbeat-work')).to_contain_text('AI 正在写文档')
            report['checks']['claimed_writing_still_requires_short_checks']=True
            pages[0].evaluate('navigator.clipboard.writeText=async text=>{window.copiedReminder=text}')
            pages[0].get_by_role('button',name='复制提醒',exact=True).click()
            copied=pages[0].evaluate('window.copiedReminder');identity=json.loads(copied.split('\n')[-1])
            assert set(identity)=={'session_id','current_round','url'} and identity['session_id']==thinking.state()['session_id']
            assert thinking.state()['nodes'][0]['answer']['text'] not in copied
            assert '第一步先运行一次 check.mjs' in copied and 'curl GET 不算轮询' in copied
            report['checks']['highlighted_copy_reminder_still_contains_only_locator_fields']=True
            fresh=browser.new_page(reduced_motion='reduce');fresh.clock.install();fresh.goto(thinking.url);fresh.wait_for_load_state('networkidle')
            expect(fresh.get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
            assert not PAUSED.search(fresh.locator('#card').inner_text())
            fresh.clock.fast_forward(31000);expect(fresh.locator('#ai-wait-notice')).to_have_text(PAUSED);fresh.close()
            report['checks']['fresh_page_grace_prevents_immediate_stale_timestamp_alarm']=True
            for index,(s,page,title) in enumerate(zip([thinking,queued],pages,['正在想下一轮的问题…','正在生成任务文档…'])):
                resumed_at=time.monotonic();ai_check(s)
                expect(page.get_by_role('heading',name=title,exact=True)).to_be_visible()
                expect(page.locator('#ai-wait-notice')).to_have_count(0)
                report.setdefault('resume_ms',{})[str(index)]=round((time.monotonic()-resumed_at)*1000)
                assert report['resume_ms'][str(index)]<3000
                expect(page.locator('#copy-reminder')).to_have_class('small-action')
                assert page.locator('#wait-elapsed').get_attribute('data-since')==since[index]
                assert s.file.read_bytes()==originals[index]
            report['checks']['only_resumed_check_clears_warning_without_resetting_wait_or_answers']=True
            for s in [thinking,queued]:
                events=[json.loads(line)['event'] for line in Path(str(s.file)+'.runtime-timings.jsonl').read_text(encoding='utf-8').splitlines()]
                assert 'pause_shown' in events and 'pause_cleared' in events and 'ai_resumed' in events
            report['checks']['pause_display_and_actual_resume_are_logged']=True
            def stale_projection(route):
                response=route.fetch();data=response.json();data['ai']['seconds_since_last_check']=61
                route.fulfill(response=response,json=data)
            # Restart the same state file on the same URL; do not recreate or write the tree.
            old_instance=thinking.startup['instance_id'];port=thinking.startup['port'];thinking.close()
            thinking.child=subprocess.Popen(['node',str(BASE/'scripts/server.mjs'),'--state',str(thinking.file),'--port',str(port),'--wait-ms','150'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
            thinking.startup=json.loads(thinking.child.stdout.readline());assert thinking.startup['instance_id']!=old_instance
            assert thinking.startup['url']==thinking.url and thinking.file.read_bytes()==originals[0]
            expect(pages[0].get_by_role('heading',name='等待 AI 对话连接',exact=True)).to_be_visible()
            assert request(thinking.url,'/progress')[1]['ai']['last_check_at'] is None
            assert not PAUSED.search(pages[0].locator('#card').inner_text())
            ai_check(thinking);expect(pages[0].get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
            assert thinking.file.read_bytes()==originals[0]
            report['checks']['same_url_restart_clears_receipt_then_reconnects_without_rewriting_tree']=True
            pages[0].route('**/progress',stale_projection)
            code,_=request(thinking.url,'/round',{'expected_revision':thinking.state()['revision'],'round':2,'nodes':[node('B','用户待答的下一题',deps=['A'],round=2)]});assert code==200
            expect(pages[0].locator('.tree-node[data-node-id=B]')).to_be_visible();pages[0].locator('.tree-node[data-node-id=B]').click();expect(pages[0].get_by_role('heading',name='用户待答的下一题',exact=True)).to_be_visible();expect(pages[0].locator('#ai-wait-notice')).to_have_count(0)
            report['checks']['pending_human_question_does_not_show_ai_pause']=True
            start_heartbeat(thinking);meta=request(thinking.url,'/recovery')[1]
            code,_=request(thinking.url,'/ai/work',{'expected_revision':thinking.state()['revision'],'expected_instance_id':meta['instance_id'],'action':'start','operation_id':'ui-code','final_round':True});assert code==200
            expect(pages[0].locator('#heartbeat-work')).to_contain_text('AI 正在查代码')
            report['checks']['heartbeat_is_only_a_work_label']=True
            browser.close()
        assert not report['errors'],report['errors'];report['status']='passed'
    except Exception as error:
        report['status']='failed';report['failure']=str(error);raise
    finally:
        for heartbeat in heartbeats:
            try:os.kill(heartbeat['pid'],15)
            except OSError:pass
        thinking.close();queued.close();(work/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);args=parser.parse_args();print(json.dumps(run(args.work),ensure_ascii=False,indent=2))
