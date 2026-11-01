"""Controlled browser/API evidence for v2; not a real model or human interview."""
import argparse,json,subprocess,os,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_acceptance import Service,seed,node,request,no_overflow,document_fixture

BASE=Path(__file__).resolve().parents[1]
def run(work):
    work.mkdir(parents=True,exist_ok=True)
    report={'kind':'controlled v2 browser regression; synthetic input and writer fixture, no model speed claim','checks':{},'errors':[]}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for width,height,label in [(1440,1000,'desktop'),(390,844,'mobile')]:
            multi=node('channels','首版需要哪些通知渠道？',options=[{'id':'mail','label':'邮件通知'},{'id':'inbox','label':'站内通知'},{'id':'none','label':'都不需要','exclusive':True}])
            multi.update(input='multi_choice',rationale='决定首版需要开发和验收的通知渠道。',recommendation={'option_ids':['mail'],'reason':'AI 建议先考虑邮件，但由用户自己选择。','source_ids':[]})
            service=Service(work/label,seed([multi,node('boundary','需要保留的原始说明？')]))
            detached=None;context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
            context.grant_permissions(['clipboard-read','clipboard-write'],origin=service.url)
            page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
            try:
                page.goto(service.url);page.wait_for_load_state('networkidle');expect(page.locator('#card .why')).to_contain_text('决定首版')
                boxes=page.get_by_role('checkbox');expect(boxes).to_have_count(3)
                for box in boxes.all():expect(box).not_to_be_checked()
                expect(page.locator('.recommendation-badge')).to_have_count(1);expect(page.locator('#confirm-answer')).to_be_disabled()
                before=service.file.read_bytes();page.keyboard.press('1');page.keyboard.press('2')
                expect(boxes.nth(0)).to_be_checked();expect(boxes.nth(1)).to_be_checked()
                page.keyboard.press('3');expect(boxes.nth(2)).to_be_checked();expect(boxes.nth(0)).not_to_be_checked();expect(boxes.nth(1)).not_to_be_checked()
                page.keyboard.press('2');expect(boxes.nth(1)).to_be_checked();expect(boxes.nth(2)).not_to_be_checked();page.keyboard.press('1')
                notes='  保留多行\n<em>原文不是 HTML</em> 🌱  '
                page.locator('.notes > summary').click();page.get_by_label('补充说明（可选）',exact=True).fill(notes)
                no_overflow(page);page.screenshot(path=str(work/(label+'-multi.png')),full_page=True)
                page.keyboard.press('Tab');page.locator('#confirm-answer').click();expect(page.locator('.tree-node[data-local=true]')).to_have_count(1)
                assert service.file.read_bytes()==before
                raw='这是秘密原文，不得出现在复制提醒里。';page.get_by_role('textbox').fill(raw);page.locator('#confirm-answer').click()
                page.get_by_role('button',name='复制提醒',exact=True).click();copied=page.evaluate('navigator.clipboard.readText()');data=json.loads(copied.split('\n')[-1])
                assert set(data)=={'session_id','current_round','url'} and data['session_id']==service.state()['session_id']
                assert raw not in copied and notes not in copied and 'tree.json' not in copied and 'job_id' not in copied
                page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('clipboard denied')}},configurable:true})")
                page.get_by_role('button',name='复制提醒',exact=True).click();expect(page.get_by_role('dialog')).to_be_visible();assert page.get_by_label('续接提醒',exact=True).input_value()==copied.replace('\r\n','\n')
                page.get_by_role('button',name='关闭',exact=True).click();expect(page.get_by_role('button',name='复制提醒',exact=True)).to_be_focused()
                page.get_by_role('button',name='提交本轮答案',exact=True).click();expect(page.locator('#card')).to_contain_text('正在想下一轮的问题')
                current=service.state();assert current['nodes'][0]['answer']=={'option_ids':['mail','inbox'],'text':notes}
                follow=node('follow','如何验收这两种通知？',deps=['channels'],round=2,options=[{'id':'both','label':'逐项验收'},{'id':'other','label':'其他方式'}])
                follow.update(rationale='决定通知渠道的验收范围，避免只测其中一个。',recommendation={'option_ids':['both'],'reason':'依据你已选的渠道逐项核验。','source_ids':['channels']})
                assert request(service.url,'/round',{'round':2,'expected_revision':current['revision'],'nodes':[follow]})[0]==200
                expect(page.get_by_role('heading',name=follow['question'],exact=True)).to_be_visible();expect(page.locator('.recommendation-source')).to_contain_text('根据你第 1 轮说的')
                expect(page.get_by_role('radio').first).not_to_be_checked()
                page.locator('.tree-node[data-node-id=channels]').click();page.get_by_role('button',name='修改回答',exact=True).click()
                expect(page.get_by_role('checkbox').nth(0)).to_be_checked();expect(page.get_by_role('checkbox').nth(1)).to_be_checked()
                page.get_by_role('checkbox').nth(2).check();page.get_by_role('button',name='保存并确认此题',exact=True).click()
                expect(page.locator('.recommendation-info')).to_contain_text('旧推荐已隐藏');expect(page.locator('.recommendation-badge')).to_have_count(0)
                for radio in page.get_by_role('radio').all():expect(radio).not_to_be_checked()
                assert service.state()['nodes'][0]['answer']['option_ids']==['none']
                page.screenshot(path=str(work/(label+'-stale-recommendation.png')),full_page=True)
                page.get_by_role('radio').nth(1).check();page.get_by_role('button',name='保存并确认此题',exact=True).click();expect(page.locator('#card')).to_contain_text('生长中')
                revision=service.state()['revision'];assert request(service.url,'/document/control',{'action':'offer','expected_revision':revision})[0]==200
                page.get_by_role('button',name='保存并生成任务文档',exact=True).click();expect(page.locator('#card')).to_contain_text('正在生成任务文档')
                frozen=service.file.read_bytes();identity=service.state()['session_id'];original_url=service.url;original_document=service.startup['document_file'];service.close()
                result=subprocess.run(['node',str(BASE/'scripts/check.mjs'),'--url',original_url,'--session',identity,'--restart','--state',str(service.file),'--document',original_document],capture_output=True,text=True,encoding='utf-8',timeout=12,check=True)
                restored=json.loads(result.stdout);detached=restored['service']['pid'];service.url=restored['url']
                assert restored['session_id']==identity and service.file.read_bytes()==frozen
                if restored['url']!=original_url:page.goto(restored['url']);page.wait_for_load_state('networkidle')
                expect(page.get_by_role('button',name='重试生成文档',exact=True)).to_be_visible(timeout=10000);page.get_by_role('button',name='重试生成文档',exact=True).click()
                status=request(service.url,'/document/status')[1]
                assert status['phase']=='requested';assert request(service.url,'/document/control',{'action':'claim','expected_revision':restored['revision'],'job_id':status['job_id']})[0]==200
                output=Path(original_document);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(document_fixture(status),encoding='utf-8')
                assert request(service.url,'/document/control',{'action':'ready','expected_revision':restored['revision'],'job_id':status['job_id']})[0]==200
                expect(page.get_by_role('link',name='打开完整任务文档',exact=True)).to_be_visible();no_overflow(page)
                assert service.file.read_bytes()==frozen
                page.screenshot(path=str(work/(label+'-recovered-ready.png')),full_page=True)
                report['checks'][label]={'multi_keyboard_mouse_exclusive_and_no_preselection':True,'why_and_source_round':True,'draft_then_batch_raw_text':True,'reminder_three_fields_no_answers':True,'stale_advice_not_answer':True,'killed_service_frozen_tree_recovery':True,'no_horizontal_overflow':True}
            finally:
                context.close();service.close()
                if detached:
                    try:os.kill(detached,15)
                    except OSError:pass
        browser.close()
    assert not report['errors'],report['errors'];report['status']='passed';(work/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);args=parser.parse_args();run(args.work.resolve())
