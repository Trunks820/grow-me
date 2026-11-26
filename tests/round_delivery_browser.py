"""Verify the visible-time countdown and undo against the real submit endpoint."""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, no_overflow, node, open_question, request, seed


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


def viewing_seed():
    prior = dict(node('prior', '之前没看懂的题'), status='answered',
                 answer={'option_ids': [], 'text': '', 'unclear': True})
    again = dict(node('end', '换个说法再问', deps=['prior'], round=2), rephrases='prior')
    return seed([prior, node('other', answered=True), node('scope', round=2), again], round=2)


def finish_round(page):
    open_question(page, 'scope')
    fill(page, '先答这一题。')
    open_question(page, 'end')
    fill(page, '换个说法我懂了。')


def resume_after_viewing(browser, work):
    cases = ['reply-close', 'reply-esc', 'reply-view', 'countdown-view', 'unfinished',
             'edit', 'edit-failed', 'revision', 'summary', 'mobile']
    for case in cases:
        service = Service(work / case, viewing_seed())
        mobile = case == 'mobile'
        page = browser.new_page(viewport={'width': 320, 'height': 600} if mobile else {'width': 1440, 'height': 900})
        try:
            page.clock.install()
            page.goto(service.url)
            pause_clock(page)
            submissions = record_submissions(page)
            before = service.file.read_bytes()
            delivery = page.locator('#round-delivery')
            bar_submit = page.get_by_role('button', name='这一轮交给 AI', exact=True)

            if case == 'unfinished':
                # Browsing flowers before the round is complete never submits.
                open_question(page, 'scope')
                fill(page, '只答了一题。')
                page.clock.run_for(1600)
                open_question(page, 'prior')
                page.locator('#close-node').click()
                page.clock.run_for(7000)
                expect(delivery).to_be_hidden()
                expect(bar_submit).to_have_count(0)
                assert not submissions and service.file.read_bytes() == before
                continue

            finish_round(page)
            if case in ('reply-close', 'reply-esc'):
                # Closing Mochi's reply skips it and the basket leaves at once.
                page.clock.run_for(300)
                if case == 'reply-esc':
                    page.keyboard.press('Escape')
                else:
                    page.locator('#close-node').click()
                expect(delivery).to_be_visible()
            elif case in ('reply-view', 'countdown-view', 'mobile'):
                # Viewing a flower pauses the delivery; closing it brings the basket back.
                page.clock.run_for(300 if case == 'reply-view' else 1600)
                if case != 'reply-view':
                    expect(delivery).to_be_visible()
                open_question(page, 'prior')
                expect(delivery).to_be_hidden()
                expect(bar_submit).to_be_visible()
                if mobile:
                    no_overflow(page)
                    expect(page.locator('#round-count .round-label')).to_be_hidden()
                    summary_box = page.locator('#round-summary').bounding_box()
                    submit_box = bar_submit.bounding_box()
                    plan_box = page.locator('#request-plan').bounding_box()
                    assert summary_box['x'] + summary_box['width'] <= submit_box['x']
                    assert submit_box['x'] + submit_box['width'] <= plan_box['x']
                    assert plan_box['x'] + plan_box['width'] <= 320
                    page.screenshot(path=str(work / 'mobile-viewing.png'))
                page.clock.run_for(7000)
                assert not submissions and service.file.read_bytes() == before
                if case == 'countdown-view':
                    page.keyboard.press('Escape')
                else:
                    page.locator('#close-node').click()
                expect(delivery).to_be_visible()
                expect(bar_submit).to_be_hidden()
                if mobile:
                    expect(page.locator('#round-count .round-label')).to_be_visible()
            elif case in ('revision', 'summary'):
                # A changed page, or an explicit look at the answer list, does not bring the basket back.
                page.clock.run_for(1600)
                open_question(page, 'prior')
                if case == 'revision':
                    answer = {'option_ids': [], 'text': 'other 原答案'}
                    assert request(service.url, '/reopen', {'id': 'other', 'expected_revision': 0})[0] == 200
                    assert request(service.url, '/decision', {'id': 'other', 'expected_revision': 1, 'answer': answer})[0] == 200
                    page.clock.run_for(2000)
                    expect(page.locator('#meta')).to_have_attribute('data-revision', '2')
                    page.locator('#close-node').click()
                else:
                    page.locator('#round-summary').click()
                    expect(page.locator('#node-dialog')).to_have_attribute('data-mode', 'summary')
                    page.locator('#close-node').click()
                page.clock.run_for(7000)
                expect(delivery).to_be_hidden()
                expect(bar_submit).to_be_visible()
                assert not submissions
                continue
            elif case == 'edit-failed':
                # Asking to change an old answer ends the delivery even when reopening it fails.
                page.clock.run_for(1600)
                page.route('**/reopen', lambda route: route.fulfill(status=503, body='{}'))
                open_question(page, 'prior')
                page.get_by_role('button', name='改', exact=True).click()
                expect(page.locator('#node-dialog')).to_have_attribute('data-mode', 'read')
                page.locator('#close-node').click()
                page.clock.run_for(7000)
                expect(delivery).to_be_hidden()
                expect(bar_submit).to_be_visible()
                assert not submissions
                continue
            elif case == 'edit':
                # Opening an answer to change it ends the delivery; the bar button still submits.
                page.clock.run_for(1600)
                open_question(page, 'scope', edit=True)
                page.locator('#close-node').click()
                page.clock.run_for(7000)
                expect(delivery).to_be_hidden()
                assert not submissions and service.file.read_bytes() == before
                expect(bar_submit).to_be_visible()
                with page.expect_response('**/submit') as submitted:
                    bar_submit.click()
                assert submitted.value.ok and len(submissions) == 1
                continue

            # Every resumed or skipped delivery is a fresh 5-second countdown that submits exactly once.
            expect(delivery.get_by_role('timer')).to_have_text('5 秒后自动交')
            page.clock.run_for(4999)
            assert not submissions and service.file.read_bytes() == before
            with page.expect_response('**/submit') as submitted:
                page.clock.run_for(1)
            assert submitted.value.ok and len(submissions) == 1
            assert [a['answer']['text'] for a in submissions[0]['answers']] == ['先答这一题。', '换个说法我懂了。']
            page.clock.run_for(6000)
            assert len(submissions) == 1
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
        resume_after_viewing(browser, work / 'viewing')
        yellow_leaf(browser, work / 'review')
        browser.close()
    print('Round auto-submit, visible time, undo, editing, viewing, yellow leaves and reduced motion passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
