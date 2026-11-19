"""Submit deferred and confirmed answers together through the real page."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, node, open_question, open_summary, seed


def run(work):
    service = Service(work / 'runtime', seed([
        node('delivery', '要用哪种通知方式？', options=[{'id': 'mail', 'label': '邮件通知'}]),
        node('timing', '什么时候开始通知？'),
        node('signup', '报名需要什么入口？'),
    ]))
    before = service.file.read_bytes()
    note = '先核对活动时间\n再决定'
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(service.url)

            open_question(page, 'delivery')
            expect(page.locator('#confirm-answer')).to_be_disabled()
            page.get_by_role('button', name='待定', exact=True).click()
            expect(page.locator('#node-dialog')).to_be_hidden()
            marker = page.locator('.tree-node[data-node-id="delivery"]')
            expect(marker).to_have_attribute('data-status', 'deferred')
            expect(marker).to_have_attribute('data-local', 'true')
            expect(marker.locator('use')).to_have_attribute('href', '#tree-deferred')

            open_question(page, 'timing')
            page.get_by_role('textbox').fill(note)
            page.get_by_role('button', name='待定', exact=True).click()
            open_question(page, 'signup')
            page.get_by_role('textbox').fill('统一报名入口')
            page.get_by_role('button', name='就这么定', exact=True).click()
            expect(page.locator('.tree-node[data-node-id="signup"] use')).to_have_attribute('href', '#tree-flower')

            open_summary(page)
            expect(page.locator('.summary-list li').filter(has_text='要用哪种通知方式？')).to_contain_text('待定')
            expect(page.locator('.summary-list li').filter(has_text='什么时候开始通知？')).to_contain_text('先核对活动时间')
            assert service.file.read_bytes() == before
            submit = page.get_by_role('button', name='提交本轮答案', exact=True)
            expect(submit).to_be_enabled()
            submit.click()
            expect(page.locator('#meta')).to_have_attribute('data-revision', '1')
            expect(page.locator('#meta')).to_contain_text('已确认 1 / 3')
            expect(page.locator('#meta')).to_contain_text('待定 2')
            saved = service.state()
            assert saved['schema_version'] == 2
            assert saved['revision'] == 1
            assert all(n['status'] == 'answered' for n in saved['nodes'])
            assert saved['nodes'][0]['answer'] == {'option_ids': [], 'text': '', 'deferred': True}
            assert saved['nodes'][1]['answer'] == {'option_ids': [], 'text': note, 'deferred': True}

            page.reload()
            expect(marker).to_have_attribute('data-local', 'false')
            expect(marker.locator('use')).to_have_attribute('href', '#tree-deferred')
            open_question(page, 'timing')
            expect(page.locator('#node-dialog')).to_have_attribute('data-mode', 'read')
            expect(page.locator('#node-body .answer')).to_contain_text('待定')
            expect(page.locator('#node-body .draft-hint')).to_have_text('第 1 轮 · 待定')
            assert not errors, errors
            browser.close()
    finally:
        service.close()

    report = json.dumps({'status': 'passed', 'check': 'deferred round submission and reload'})
    (work / 'report.json').write_text(report, encoding='utf-8')
    print(report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
