"""AI presence across query silence using the real service and a controlled clock."""
import argparse,json,subprocess,re,os,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_acceptance import Service, seed, node, request, no_overflow, ai_check, document_fixture, open_summary
from sim_user import WATCH_PAUSES

BASE=Path(__file__).resolve().parents[1]
PAUSED=re.compile(r'已 \d+ 秒没收到 AI 回应，回聊天窗口发"继续"')
WORK_LEASE_MS = 180_000
STALE_CHECK_MS = 63_000
CHAPTER_GAP_MS = 100_000


def ai_status(service):
    return request(service.url, '/progress')[1]['ai']


def refresh_progress(page, advance_ms=1100):
    with page.expect_response('**/progress') as response:
        page.clock.fast_forward(advance_ms)
    response.value.finished()
    page.wait_for_timeout(100)


def run(work):
    work.mkdir(parents=True,exist_ok=True)
    report={'kind':'controlled UI/API; heartbeat, work leases and pause recovery','checks':{},'errors':[]}
    heartbeats=[]
    thinking = Service(work / 'thinking', seed([node('A', '待确认的需求')]), clock=True)
    queued = Service(work / 'queued', seed([
        node('A', '等待写入文档的需求', answered=True), node('B', '另一个文档章节', answered=True),
    ]), clock=True)
    def start_heartbeat(service):
        heartbeat=json.loads(subprocess.check_output(['node',str(BASE/'scripts/check.mjs'),'--url',service.url,'--session',service.state()['session_id'],'--heartbeat','--owner-pid',str(os.getpid())],text=True,encoding='utf-8'))
        assert heartbeat['owner_pid']==os.getpid() and heartbeat['lease_ms']==180000
        heartbeats.append(heartbeat);return heartbeat
    def stop_heartbeat(service,heartbeat):
        receipt=json.loads(subprocess.check_output(['node',str(BASE/'scripts/check.mjs'),'--url',service.url,'--session',service.state()['session_id'],'--heartbeat-stop',heartbeat['heartbeat_id']],text=True,encoding='utf-8'))
        assert not receipt['active']
    def control(action,**extra):
        code,result=request(queued.url,'/document/control',{'action':action,'expected_revision':queued.state()['revision'],**extra});assert code==200,(code,result);return result
    try:
        startup_ai = ai_status(thinking)
        assert startup_ai['work_active'] and startup_ai['last_check_at'] is None
        code, result = request(thinking.url, '/submit', {
            'round': 1, 'expected_revision': 0,
            'answers': [{'id': 'A', 'answer': {'option_ids': [], 'text': 'A 原答案'}}],
        })
        assert code == 200, (code, result)
        assert ai_status(thinking)['work_until'] == startup_ai['work_until']
        control('offer');job=control('save')['job_id']
        originals=[s.file.read_bytes() for s in [thinking,queued]]
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            pages=[];since=[]
            for s,width,title in [(thinking,1440,'正在想下一轮的问题…'),(queued,390,'正在生成任务文档…')]:
                page=browser.new_page(viewport={'width':width,'height':900},reduced_motion='reduce');pages.append(page)
                page.on('pageerror',lambda error:report['errors'].append(str(error)))
                page.add_init_script(WATCH_PAUSES)
                page.clock.install()
                page.goto(s.url);page.wait_for_load_state('networkidle')
                expect(page.get_by_role('heading',name=title,exact=True)).to_be_visible()
                expect(page.locator('#copy-reminder')).not_to_have_class('small-action needs-attention')
                assert not PAUSED.search(page.locator('#card').inner_text())
                ai = ai_status(s)
                assert ai['work_active'] and ai['last_check_at'] is None and ai['last_heartbeat_at'] is None
                since.append(page.locator('#wait-elapsed').get_attribute('data-since'))
                no_overflow(page)
            report['checks']['startup_keeps_first_submission_online_before_first_check']=True
            report['checks']['offer_keeps_queued_online_before_first_check']=True
            first = start_heartbeat(thinking)
            expect(pages[0].locator('#heartbeat-work')).to_be_visible()
            assert ai_status(thinking)['last_check_at'] is None
            stop_heartbeat(thinking, first)
            expect(pages[0].locator('#heartbeat-work')).to_be_hidden()

            running = []
            for service, page in zip([thinking, queued], pages):
                ai_check(service)
                service.set_clock_offset(STALE_CHECK_MS)
                running.append(start_heartbeat(service))
                refresh_progress(page, 31_000)
                ai = ai_status(service)
                assert ai['heartbeat_active'] and ai['seconds_since_last_check'] > 60
                assert ai['seconds_since_last_heartbeat'] < 12
                expect(page.locator('#heartbeat-work')).to_be_visible()
                expect(page.locator('#ai-wait-notice')).to_have_count(0)
                expect(page.locator('#copy-reminder')).not_to_have_class('small-action needs-attention')
            report['checks']['live_heartbeats_prevent_pause_in_thinking_and_queued']=True
            claimed = control('claim', job_id=job)
            expect(pages[1].locator('#heartbeat-work')).to_contain_text('AI 正在写文档')
            expect(pages[1].locator('#ai-wait-notice')).to_have_count(0)
            report['checks']['live_heartbeat_keeps_claimed_writer_online']=True
            for service, page, heartbeat in zip([thinking, queued], pages, running):
                stop_heartbeat(service, heartbeat)
                expect(page.locator('#heartbeat-work')).to_be_hidden()
                assert ai_status(service)['work_active']
                expect(page.locator('#ai-wait-notice')).to_have_count(0)

            writer = pages[1]
            last_check = ai_status(queued)['last_check_at']
            preview = Path(claimed['source']['document_file'] + '.preview.html')
            preview.parent.mkdir(parents=True, exist_ok=True)
            preview_html = document_fixture(claimed)
            chapters = claimed['source']['chapters']
            for index, chapter in enumerate(chapters, 1):
                queued.set_clock_offset(STALE_CHECK_MS + CHAPTER_GAP_MS * index)
                refresh_progress(writer)
                expect(writer.locator('#ai-wait-notice')).to_have_count(0)
                tag = f'<article id="{chapter["anchor"]}"'
                preview_html = preview_html.replace(tag + '>', tag + ' data-chapter-ready="true">')
                preview.write_text(preview_html, encoding='utf-8')
                control('chapter', job_id=job, chapter_id=chapter['id'])
                expect(writer.locator('.tree-fruit[data-availability=ready]')).to_have_count(index)
            queued.set_clock_offset(STALE_CHECK_MS + CHAPTER_GAP_MS * (len(chapters) + 1))
            refresh_progress(writer)
            ai = ai_status(queued)
            assert ai['work_active'] and not ai['heartbeat_active'] and ai['last_check_at'] == last_check
            expect(writer.locator('#ai-wait-notice')).to_have_count(0)
            assert not writer.evaluate('window.simUserPauses')
            report['checks']['sequential_chapter_publication_keeps_writer_online']=True

            expired_offset = STALE_CHECK_MS + CHAPTER_GAP_MS * len(chapters) + WORK_LEASE_MS + 1000
            report['silence_seconds']={}
            for label,s,page in zip(['thinking','queued'],[thinking,queued],pages):
                s.set_clock_offset(expired_offset)
                ai = ai_status(s)
                assert not ai['heartbeat_active'] and not ai['work_active']
                age = ai['seconds_since_last_check']
                assert age > 60
                report['silence_seconds'][label] = age
                expect(page.locator('#ai-wait-notice')).to_have_text(PAUSED,timeout=5000)
                recovery=request(s.url,'/recovery')[1]['ai'];assert recovery['last_check_at']==ai['last_check_at'] and recovery['seconds_since_last_check']>60
                visible_age=int(re.search(r'已 (\d+) 秒',page.locator('#ai-wait-notice').inner_text()).group(1));assert abs(visible_age-age)<3
                expect(page.locator('#copy-reminder')).to_have_class('small-action needs-attention')
                expect(page.locator('#copy-reminder')).to_have_attribute('aria-describedby','ai-wait-notice')
                text=page.locator('#card').inner_text();assert '生长中' not in text and '还在想' not in text
                no_overflow(page);page.screenshot(path=str(work/(label+'-paused.png')),full_page=True)
            report['checks']['work_lease_expiry_reveals_existing_query_silence']=True
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
            report['checks']['resumed_check_clears_warning_without_resetting_wait_or_answers']=True
            for s in [thinking,queued]:
                events=[json.loads(line)['event'] for line in Path(str(s.file)+'.runtime-timings.jsonl').read_text(encoding='utf-8').splitlines()]
                assert 'pause_shown' in events and 'pause_cleared' in events and 'ai_resumed' in events
            report['checks']['pause_display_and_actual_resume_are_logged']=True
            def stale_projection(route):
                response=route.fetch();data=response.json();data['ai'].update(seconds_since_last_check=61, work_active=False)
                route.fulfill(response=response,json=data)
            # Restart the same state file on the same URL; do not recreate or write the tree.
            old_instance, origin, port = thinking.startup['instance_id'], thinking.url, thinking.startup['port']
            old_deadline = ai_status(thinking)['work_until']
            thinking.close()
            thinking.start(port)
            assert thinking.startup['instance_id'] != old_instance
            assert thinking.url == origin and thinking.file.read_bytes() == originals[0]
            refresh_progress(pages[0])
            expect(pages[0].get_by_role('heading',name='正在想下一轮的问题…',exact=True)).to_be_visible()
            restarted = ai_status(thinking)
            assert restarted['last_check_at'] is None and restarted['work_active']
            assert restarted['work_until'] > old_deadline
            assert not PAUSED.search(pages[0].locator('#card').inner_text())
            ai_check(thinking)
            assert thinking.file.read_bytes()==originals[0]
            report['checks']['same_url_restart_starts_fresh_work_lease_without_rewriting_tree']=True
            refresh_progress(pages[0], 31_000)
            pages[0].route('**/progress',stale_projection)
            code,_=request(thinking.url,'/round',{'expected_revision':thinking.state()['revision'],'round':2,'nodes':[node('B','用户待答的下一题',deps=['A'],round=2)]});assert code==200
            expect(pages[0].locator('.tree-node[data-node-id=B]')).to_be_visible();pages[0].locator('.tree-node[data-node-id=B]').click();expect(pages[0].get_by_role('heading',name='用户待答的下一题',exact=True)).to_be_visible();expect(pages[0].locator('#ai-wait-notice')).to_have_count(0)
            report['checks']['pending_human_question_does_not_show_ai_pause']=True
            pages[0].unroute('**/progress', stale_projection)
            heartbeat = start_heartbeat(thinking);meta=request(thinking.url,'/recovery')[1]
            code,_=request(thinking.url,'/ai/work',{'expected_revision':thinking.state()['revision'],'expected_instance_id':meta['instance_id'],'action':'start','operation_id':'ui-code','final_round':True});assert code==200
            expect(pages[0].locator('#heartbeat-work')).to_contain_text('AI 正在查代码')
            report['checks']['heartbeat_shows_code_read_label']=True
            stop_heartbeat(thinking, heartbeat)

            interview = pages[0]
            before_submit_offset = expired_offset + WORK_LEASE_MS + 1000
            thinking.set_clock_offset(before_submit_offset)
            assert not ai_check(thinking)['changed'] and not ai_status(thinking)['work_active']
            interview.evaluate('window.simUserPauses.length = 0')
            interview.get_by_role('textbox').fill('用户提交后由 AI 准备下一轮。')
            interview.get_by_role('button', name='好了', exact=True).click()
            open_summary(interview)
            with interview.expect_response('**/submit') as submitted:
                interview.get_by_role('button', name='提交本轮答案', exact=True).click()
            assert submitted.value.ok
            receipt = ai_check(thinking)
            assert receipt['changed'] and [event['kind'] for event in receipt['events']] == ['submit']
            thinking.set_clock_offset(before_submit_offset + 91_000)
            refresh_progress(interview, 90_000)
            ai = ai_status(thinking)
            assert ai['seconds_since_last_check'] >= 90 and ai['work_active'] and not ai['heartbeat_active']
            expect(interview.get_by_role('heading', name='正在想下一轮的问题…', exact=True)).to_be_visible()
            expect(interview.locator('#ai-wait-notice')).to_have_count(0)
            code, _ = request(thinking.url, '/round', {
                'expected_revision': receipt['revision'], 'round': 3,
                'nodes': [node('C', '已经发布的下一轮', deps=['B'], round=3)],
            })
            assert code == 200
            expect(interview.locator('.tree-node[data-node-id=C]')).to_be_visible()
            assert not interview.evaluate('window.simUserPauses')
            report['checks']['changed_check_spans_90_seconds_until_next_round']=True
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
