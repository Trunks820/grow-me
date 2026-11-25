"""Verify the visible-time countdown and undo against the real submit endpoint."""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, no_overflow, node, open_question, seed


def record_submissions(page):
    submissions = []

    def track(request):
        if request.method == 'POST' and urlsplit(request.url).path == '/submit':
            submissions.append(request.post_data_json)

    page.on('request', track)
    return submissions


def fill(page, text):
    page.get_by_role('textbox').fill(text)
    page.keyboard.press('Control+Enter')


def set_hidden(page, hidden):
    page.evaluate('''hidden => {
        Object.defineProperty(document, 'hidden', {value: hidden, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
    }''', hidden)


def pause_clock(page):
    page.clock.pause_at(datetime.now(timezone.utc) + timedelta(seconds=1))


def auto_submit(browser, work):
    last_reply = '好，我把最后这条也记下了。'
    service = Service(work / 'runtime', seed([
        node('scope', '先做什么？'), dict(node('end', '还有什么要求？'), reply=last_reply),
    ]))
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    try:
        page.clock.install()
        page.goto(service.url)
        open_question(page, 'scope')
        fill(page, '先做活动报名。')
        open_question(page, 'end')
        pause_clock(page)

        submissions = record_submissions(page)
        before = service.file.read_bytes()
        delivery = page.locator('#round-delivery')
        fill(page, '先记这句。')
        expect(page.locator('#node-question')).to_have_text(last_reply)
        expect(page.locator('.tree-node[data-node-id=end] .tree-symbol')).to_have_attribute('href', '#tree-flower')
        expect(delivery).to_be_hidden()
        page.clock.run_for(1000)
        open_question(page, 'scope', edit=True)
        page.clock.run_for(6500)
        expect(delivery).to_be_hidden()
        assert not submissions and service.file.read_bytes() == before

        open_question(page, 'end', edit=True)
        fill(page, '  保留原话\n请记下这行。  ')
        page.clock.run_for(1499)
        expect(page.locator('#node-question')).to_have_text(last_reply)
        expect(delivery).to_be_hidden()
        assert not submissions
        page.clock.run_for(1)
        clock = delivery.get_by_role('timer')
        expect(delivery.get_by_role('heading')).to_have_text('这一轮 2 题都定了，我送去给 AI 啦～')
        expect(clock).to_have_text('5 秒后自动交')
        expect(delivery.get_by_role('button')).to_be_focused()
        assert delivery.locator('.delivery-art').evaluate('art => art.getAnimations().length') == 1
        assert delivery.locator('img').evaluate('mascot => mascot.naturalWidth > 0')
        assert delivery.locator('.delivery-basket').is_visible()
        delivery.locator('.delivery-art').evaluate('art => art.getAnimations().forEach(flight => flight.finish())')

        page.clock.run_for(2000)
        expect(clock).to_have_text('3 秒后自动交')
        no_overflow(page)
        page.screenshot(path=str(work / 'desktop-delivery.png'))
        set_hidden(page, True)
        page.clock.run_for(2999)
        expect(clock).to_have_text('1 秒后自动交')
        assert not submissions and service.file.read_bytes() == before
        with page.expect_response('**/submit') as submitted:
            page.clock.run_for(1)
        assert submitted.value.ok
        expect(delivery).to_be_hidden()
        set_hidden(page, False)
        expect(page.locator('#meta')).to_have_attribute('data-revision', '1')
        assert len(submissions) == 1
        assert service.state()['nodes'][-1]['answer']['text'] == '  保留原话\n请记下这行。  '
    finally:
        page.close()
        service.close()


def cancellation(browser, work):
    service = Service(work / 'runtime', seed([node('scope'), node('end')]))
    page = browser.new_page(viewport={'width': 320, 'height': 600}, reduced_motion='reduce')
    try:
        page.clock.install()
        page.goto(service.url)
        open_question(page, 'scope')
        fill(page, '保留这一题。')
        open_question(page, 'end')
        submissions = record_submissions(page)
        before = service.file.read_bytes()
        fill(page, '先写这么多。')
        delivery = page.locator('#round-delivery')
        undo = delivery.get_by_role('button', name='等等，我再看看')
        expect(undo).to_be_focused()
        expect(delivery.get_by_role('timer')).to_be_visible()
        expect(delivery.locator('.delivery-art')).to_be_hidden()
        expect(delivery.locator('.delivery-ring')).to_be_hidden()
        assert delivery.evaluate('panel => panel.getAnimations({subtree: true}).length') == 0
        no_overflow(page)
        page.screenshot(path=str(work / 'mobile-delivery-reduced.png'))
        page.emulate_media(reduced_motion='no-preference')
        expect(delivery.locator('.delivery-art')).to_be_visible()
        expect(delivery.locator('.delivery-ring')).to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(work / 'mobile-delivery.png'))
        page.emulate_media(reduced_motion='reduce')

        page.keyboard.press('Enter')
        summary = page.get_by_role('dialog')
        expect(summary.get_by_role('heading')).to_have_text('第 1 轮 · 答案核对')
        expect(summary.locator('.summary-list li')).to_have_count(2)
        expect(summary.get_by_role('button', name='交给 AI')).to_be_enabled()
        expect(delivery).to_be_hidden()
        page.clock.fast_forward(6000)
        assert not submissions and service.file.read_bytes() == before

        open_question(page, 'end', edit=True)
        fill(page, '重写这一题。')
        expect(delivery).to_be_visible()
        open_question(page, 'scope', edit=True)
        expect(delivery).to_be_hidden()
        expect(page.get_by_role('textbox')).to_have_value('保留这一题。')
        page.clock.fast_forward(6000)
        assert not submissions and service.file.read_bytes() == before

        fill(page, '再改第一题。')
        expect(delivery).to_be_visible()
        with page.expect_response('**/submit') as submitted:
            page.clock.fast_forward(5000)
        assert submitted.value.ok
        assert len(submissions) == 1
        assert [answer['answer']['text'] for answer in submissions[0]['answers']] == ['再改第一题。', '重写这一题。']
    finally:
        page.close()
        service.close()


def yellow_leaf(browser, work):
    old = dict(node('prior', answered=True), status='needs_review')
    service = Service(work, seed([old, node('scope', round=2)], round=2))
    page = browser.new_page(reduced_motion='reduce')
    try:
        page.clock.install()
        page.goto(service.url)
        open_question(page, 'scope')
        submissions = record_submissions(page)
        before = service.file.read_bytes()
        fill(page, '本轮答案。')
        page.clock.fast_forward(6000)
        expect(page.locator('#round-delivery')).to_be_hidden()
        assert not submissions and service.file.read_bytes() == before

        open_question(page, 'prior')
        page.get_by_role('button', name='仍然有效').click()
        expect(page.locator('#round-delivery')).to_be_visible()
        with page.expect_response('**/submit') as submitted:
            page.clock.fast_forward(5000)
        assert submitted.value.ok
        assert len(submissions) == 1 and submissions[0]['expected_revision'] == 1
    finally:
        page.close()
        service.close()


def run(work):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        auto_submit(browser, work / 'auto')
        cancellation(browser, work / 'cancel')
        yellow_leaf(browser, work / 'review')
        browser.close()
    print('Round auto-submit, visible time, undo, editing, yellow leaves and reduced motion passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
