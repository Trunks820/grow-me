"""Ask for clearer wording, submit the round and answer the replacement questions."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, capture, no_overflow, node, open_question, request, seed


def run(work):
    service = Service(work / 'runtime', seed([
        node('notice', '需要哪种通知？', options=[{'id': 'mail', 'label': '邮件通知'}]),
        node('signup', '报名入口放在哪里？'),
        node('rules', '报名的校验规则怎么定？'),
    ]))
    note = '这里的通知是发给谁的？'
    before = service.file.read_bytes()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(service.url)
            dialog = page.locator('#node-dialog')
            reword = dialog.get_by_role('button', name='没看懂，换个说法', exact=True)
            reword_note = dialog.get_by_role('textbox', name='哪里没看懂？（可不填）', exact=True)
            ask = dialog.get_by_role('button', name='请 AI 换个说法', exact=True)
            marker = page.locator('.tree-node[data-node-id="notice"]')

            expect(marker).to_have_attribute('data-visible', 'true')
            marker.focus()
            page.keyboard.press('Enter')
            expect(reword).to_have_attribute('aria-expanded', 'false')
            expect(reword_note).to_be_hidden()
            reword.focus()
            page.keyboard.press('Enter')
            expect(reword).to_have_attribute('aria-expanded', 'true')
            expect(reword_note).to_be_focused()
            page.keyboard.insert_text(note)
            capture(page, work, 'desktop-note')

            page.set_viewport_size({'width': 320, 'height': 720})
            expect(dialog).to_have_attribute('data-placement', 'sheet')
            no_overflow(page)
            page.set_viewport_size({'width': 375, 'height': 760})
            page.keyboard.press('Tab')
            expect(ask).to_be_focused()
            page.keyboard.press('Enter')
            expect(dialog.get_by_role('heading')).to_have_text('好，我让 AI 换个说法再问你')
            expect(marker).to_have_attribute('data-local', 'true')
            expect(marker).to_have_attribute('data-status', 'unclear')
            expect(marker.locator('use')).to_have_attribute('href', '#tree-unclear')
            assert page.evaluate('document.getAnimations().length') == 0
            capture(page, work, 'mobile-reply')

            expect(dialog).to_have_attribute('data-node-id', 'signup')
            dialog.get_by_role('textbox').fill('放在活动页面。')
            dialog.get_by_role('button', name='好了', exact=True).click()
            expect(dialog).to_have_attribute('data-node-id', 'rules')
            reword.click()
            expect(reword_note).to_be_focused()
            page.keyboard.press('Control+Enter')
            expect(dialog.get_by_role('heading')).to_have_text('好，我让 AI 换个说法再问你')
            expect(page.locator('#round-delivery-copy')).to_have_text('这一轮 3 题都答完了，我送去给 AI 啦～')
            expect(page.locator('#round-delivery')).to_be_visible()
            assert page.evaluate('document.getAnimations().length') == 0
            page.keyboard.press('Escape')
            expect(dialog).to_have_attribute('data-mode', 'summary')
            assert service.file.read_bytes() == before

            page.reload()
            expect(marker.locator('use')).to_have_attribute('href', '#tree-unclear')
            page.get_by_role('button', name='回看本轮答案', exact=True).click()
            expect(dialog.locator('.summary-list li').filter(has_text='需要哪种通知？')).to_contain_text(note)
            expect(dialog.locator('.summary-list li').filter(has_text='报名的校验规则怎么定？')).to_contain_text('没看懂')
            expect(dialog.get_by_role('heading')).to_be_focused()
            page.keyboard.press('Enter')
            expect(page.locator('#meta')).to_contain_text('已确认 1 / 3')
            expect(page.locator('#meta')).to_contain_text('没看懂 2')
            expect(marker).to_have_attribute('data-local', 'false')
            assert [n['answer'] for n in service.state()['nodes']] == [
                {'option_ids': [], 'text': note, 'unclear': True},
                {'option_ids': [], 'text': '放在活动页面。'},
                {'option_ids': [], 'text': '', 'unclear': True},
            ]
            no_overflow(page)
            capture(page, work, 'mobile-submitted')

            notice = node('notice-again', '活动有变化时，要给报名的人发邮件吗？', deps=['notice'], round=2)
            rules = node('rules-again', '报名时，哪些信息一定要填？', deps=['rules'], round=2)
            notice['rephrases'], rules['rephrases'] = 'notice', 'rules'
            code, _ = request(service.url, '/round', {
                'round': 2, 'expected_revision': 1, 'nodes': [notice, rules],
            })
            assert code == 200
            expect(dialog).to_have_attribute('data-node-id', 'notice-again')
            dialog.get_by_role('textbox').fill('要发邮件。')
            dialog.get_by_role('button', name='好了', exact=True).click()
            expect(dialog).to_have_attribute('data-node-id', 'rules-again')
            dialog.get_by_role('textbox').fill('填写姓名。')
            dialog.get_by_role('button', name='好了', exact=True).click()
            expect(page.locator('#round-delivery')).to_be_visible()
            page.keyboard.press('Escape')
            dialog.get_by_role('button', name='交给 AI', exact=True).click()
            expect(page.locator('#meta')).to_contain_text('已确认 3 / 3')
            open_question(page, 'notice')
            expect(dialog.locator('.draft-hint')).to_contain_text('已换个说法')
            expect(dialog.locator('.answer')).to_contain_text(note)
            assert not errors, errors
            browser.close()
    finally:
        service.close()

    print(json.dumps({'status': 'passed', 'check': 'keyboard rephrase request, draft restore and follow-up'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
