"""Exercise browser-local round drafts against the real service."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, node, open_question, open_summary, request, seed


def confirm_drafts(page, text):
    open_question(page, 'channel')
    page.get_by_role('radio', name='邮件').check()
    page.get_by_role('button', name='就这么定', exact=True).click()
    open_question(page, 'scope')
    page.get_by_role('textbox').fill(text)
    page.get_by_role('button', name='就这么定', exact=True).click()
    expect(page.locator('.tree-node[data-local=true]')).to_have_count(2)


def reload_and_publish(browser, work):
    service = Service(work, seed([
        node('prior', answered=True),
        node('channel', '用哪种渠道？', round=2, options=[{'id': 'mail', 'label': '邮件'}]),
        node('scope', '先做什么？', round=2),
    ], round=2))
    context = browser.new_context(viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
    try:
        page = context.new_page()
        errors, posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda req: posts.append(req.post_data or '') if req.method == 'POST' else None)
        before = service.file.read_bytes()
        text = '  确认后只留在浏览器\n保留原话  '
        page.goto(service.url)
        confirm_drafts(page, text)

        page.reload()
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(2)
        open_summary(page)
        answers = page.locator('.summary-list .answer')
        expect(answers).to_have_text(['邮件', text])
        expect(page.get_by_role('button', name='提交本轮答案', exact=True)).to_be_enabled()
        assert service.file.read_bytes() == before
        assert all('确认后只留在浏览器' not in body for body in posts)
        assert not errors, errors

        # Change the revision with the page closed so the next load sees the old cache.
        page.close()
        assert request(service.url, '/decision', {
            'id': 'prior', 'expected_revision': 0,
            'answer': {'option_ids': [], 'text': '复核上一轮决定'},
        })[0] == 200
        page = context.new_page()
        page.goto(service.url)
        expect(page.locator('#meta')).to_have_attribute('data-revision', '1')
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(0)
        expect(page.locator('.tree-node[data-status=pending]')).to_have_count(2)
        assert [n['answer'] for n in service.state()['nodes'][1:]] == [None, None]

        confirm_drafts(page, text)
        open_question(page, 'prior', edit=True)
        expect(page.locator('#meta')).to_have_attribute('data-revision', '2')
        expect(page.locator('.tree-node[data-node-id=prior]')).to_have_attribute('data-status', 'needs_review')
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(2)

        page.reload()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '2')
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(2)
        page.get_by_role('button', name='查看本轮草稿', exact=True).click()
        expect(page.locator('.summary-list .answer')).to_have_text(['邮件', text])
        assert [n['answer'] for n in service.state()['nodes'][1:]] == [None, None]
        page.get_by_role('button', name='关闭', exact=True).click()

        open_question(page, 'prior')
        page.get_by_role('button', name='仍然有效', exact=True).click()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '3')
        open_summary(page)
        page.get_by_role('button', name='提交本轮答案', exact=True).click()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '4')
        assert service.state()['nodes'][-1]['answer']['text'] == text
        assert request(service.url, '/round', {
            'round': 3, 'expected_revision': 4, 'nodes': [node('next', '下一轮确认什么？', round=3)],
        })[0] == 200

        page.reload()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '5')
        expect(page.locator('.tree-node[data-local=true]')).to_have_count(0)
        open_question(page, 'next')
        expect(page.get_by_role('textbox')).to_have_value('')
        assert service.state()['nodes'][-1]['answer'] is None
    finally:
        context.close()
        service.close()


def storage_unavailable(browser, work):
    service = Service(work, seed([node('scope', '先做什么？')]))
    page = browser.new_page(viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
    try:
        page.add_init_script("""Object.defineProperty(window, 'localStorage', {
            get() { throw new DOMException('Storage unavailable', 'SecurityError'); }
        });""")
        before = service.file.read_bytes()
        text = '存储不可用时仍能提交'
        page.goto(service.url)
        open_question(page, 'scope')
        page.get_by_role('textbox').fill(text)
        page.get_by_role('button', name='就这么定', exact=True).click()
        open_summary(page)
        expect(page.locator('.summary-list .answer')).to_have_text(text)
        assert service.file.read_bytes() == before
        page.get_by_role('button', name='提交本轮答案', exact=True).click()
        expect(page.locator('#meta')).to_have_attribute('data-revision', '1')
        assert service.state()['nodes'][0]['answer']['text'] == text
    finally:
        page.close()
        service.close()


def run(work):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        reload_and_publish(browser, work / 'reload')
        storage_unavailable(browser, work / 'storage-unavailable')
        browser.close()
    report = json.dumps({'status': 'passed', 'check': 'round draft restore, live review, invalidation and storage fallback'})
    (work / 'report.json').write_text(report, encoding='utf-8')
    print(report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
