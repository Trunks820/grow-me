"""Confirm an early plan request through the real page and inspect the AI receipt."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, ai_check, node, open_question, request, seed


def partial_round(browser, work):
    service = Service(work, seed([
        node('scope', '先做什么？'),
        node('timing', '什么时候截止？'),
        node('audience', '先给谁用？'),
        node('channel', '用哪种通知渠道？', options=[{'id': 'mail', 'label': '邮件'}]),
    ]))
    page = browser.new_page(viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        before = service.file.read_bytes()
        assert ai_check(service)['changed'] is False
        page.goto(service.url)

        open_question(page, 'scope')
        page.get_by_role('textbox').fill('先做报名入口')
        page.get_by_role('button', name='就这么定', exact=True).click()
        open_question(page, 'timing')
        page.get_by_role('textbox').fill('等场地回复')
        page.get_by_role('button', name='待定', exact=True).click()
        open_question(page, 'audience')
        page.get_by_role('textbox').fill('还没确认的输入')
        page.get_by_role('button', name='关闭', exact=True).click()

        trigger = page.get_by_role('button', name='够了，先出方案', exact=True)
        dialog = page.get_by_role('dialog')
        confirm = dialog.get_by_role('button', name='先出方案', exact=True)
        cancel = dialog.get_by_role('button', name='我再答几题', exact=True)
        trigger.click()
        expect(dialog.get_by_role('heading')).to_have_text('这一轮还有 2 题没答，会记成待定，直接出方案吗？')
        expect(confirm).to_be_enabled()
        assert service.file.read_bytes() == before

        cancel.click()
        expect(dialog).to_be_hidden()
        expect(trigger).to_be_focused()
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(2)
        assert service.file.read_bytes() == before
        assert ai_check(service)['changed'] is False
        open_question(page, 'audience')
        expect(page.get_by_role('textbox')).to_have_value('还没确认的输入')
        page.get_by_role('button', name='关闭', exact=True).click()

        trigger.click()
        confirm.click()
        expect(dialog).to_be_hidden()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '1')
        expect(page.locator('#meta')).to_contain_text('待定 3')
        expect(page.get_by_role('heading', name='正在准备保存…', exact=True)).to_be_visible()
        for node_id in ['timing', 'audience', 'channel']:
            marker = page.locator(f'.tree-node[data-node-id="{node_id}"]')
            expect(marker.locator('use')).to_have_attribute('href', '#tree-deferred')
            expect(marker).to_have_attribute('data-local', 'false')

        saved = service.state()
        assert saved['status'] == 'active' and saved['schema_version'] == 2
        assert all(node['status'] == 'answered' for node in saved['nodes'])
        deferred = {'option_ids': [], 'text': '', 'deferred': True}
        assert [node['answer'] for node in saved['nodes']] == [
            {'option_ids': [], 'text': '先做报名入口'},
            {**deferred, 'text': '等场地回复'},
            deferred,
            deferred,
        ]
        receipt = ai_check(service)
        assert receipt['plan_requested'] is True
        assert [event['kind'] for event in receipt['events']] == ['request_plan']
        assert request(service.url, '/document/control', {
            'action': 'offer', 'expected_revision': receipt['revision'],
        })[0] == 200
        page.get_by_role('button', name='保存并生成任务文档', exact=True).click()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '2')
        assert service.state()['status'] == 'complete'
        assert request(service.url, '/document/status')[1]['phase'] == 'requested'
        assert not errors, errors
    finally:
        page.close()
        service.close()


def answered_round(browser, work):
    service = Service(work, seed([node('scope', '先做什么？', answered=True)]))
    page = browser.new_page(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    try:
        before = service.file.read_bytes()
        page.goto(service.url)
        page.get_by_role('button', name='够了，先出方案', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('heading')).to_have_text('这一轮已答完，直接出方案吗？')
        expect(dialog.get_by_role('button', name='先出方案', exact=True)).to_be_enabled()
        dialog.get_by_role('button', name='我再答几题', exact=True).click()
        expect(dialog).to_be_hidden()
        assert service.file.read_bytes() == before
    finally:
        page.close()
        service.close()


def run(work):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        partial_round(browser, work / 'partial')
        answered_round(browser, work / 'answered')
        browser.close()
    report = json.dumps({'status': 'passed', 'check': 'confirm, cancel and save a plan request'})
    (work / 'report.json').write_text(report, encoding='utf-8')
    print(report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
