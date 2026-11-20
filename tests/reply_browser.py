"""Answer feedback with AI-written lines, fallback rotation, and reduced motion."""
import argparse
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, no_overflow, node, seed


def run(work):
    single_reply = '好呀，到时候先看看大家用起来顺不顺手。'
    multi_reply = '收到，这几项先一起记在这儿。'
    first_reply = '我记下了，之后还可以再调整。'
    text_reply = '好，我把你刚才说的记下了。'
    choices = [
        {'id': 'first', 'label': '邮件通知', 'reply': first_reply},
        {'id': 'second', 'label': '站内通知', 'reply': '这句属于第二个选项。'},
    ]
    questions = [
        node('single', '报名入口放在哪？', options=[
            {'id': 'home', 'label': '首页', 'reply': single_reply},
            {'id': 'event', 'label': '活动页', 'reply': '这句属于活动页。'},
        ]),
        dict(node('multi', '有哪些通知渠道？', options=choices), input='multi_choice', reply=multi_reply),
        dict(node('first-option', '还有哪些渠道可用？', options=choices), input='multi_choice'),
        dict(node('text', '报名信息要留多久？'), reply=text_reply),
        dict(node('no-first-reply', '哪些渠道可以试试？', options=[
            {'id': 'first', 'label': '邮件通知'}, choices[1],
        ]), input='multi_choice'),
        *(node(f'fallback-{i}', f'还要补充什么？（{i}）') for i in range(1, 5)),
        node('last', '还有要补充的吗？'),
    ]
    service = Service(work / 'runtime', seed(questions))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            flight_probe = '''
                window.flights = [];
                const animate = Element.prototype.animate;
                Element.prototype.animate = function (...args) {
                    if (this.id === 'mascot') {
                        window.flights.push({ id: this.dataset.nodeId, at: performance.now() });
                    }
                    return animate.apply(this, args);
                };
                document.addEventListener('click', event => {
                    if (event.target.matches('input[type=radio]')) window.answeredAt = performance.now();
                }, true);
            '''
            page.add_init_script(flight_probe)
            page.goto(service.url)
            dialog = page.locator('#node-dialog')
            mascot = page.locator('#mascot')
            heading = page.locator('#node-question')

            def expect_reply(id, copy=None):
                expect(dialog).to_have_attribute('data-node-id', id)
                expect(dialog).to_have_attribute('data-mode', 'reply')
                expect(heading).to_be_focused()
                expect(mascot).to_have_attribute('src', '/mascot-bloom.svg')
                if copy is not None:
                    expect(heading).to_have_text(copy)

            def confirm_choices():
                page.get_by_role('checkbox', name='站内通知').check()
                page.get_by_role('checkbox', name='邮件通知').check()
                page.get_by_role('button', name='好了', exact=True).click()

            expect(dialog).to_have_attribute('data-node-id', 'single')
            expect(page.locator('link[rel=icon]')).to_have_attribute('href', '/mascot-favicon.svg')
            for name in ['ask', 'bloom', 'sleep', 'wake', 'favicon']:
                response = page.request.get(service.url + f'/mascot-{name}.svg')
                assert response.ok and response.headers['content-type'] == 'image/svg+xml'
            before = service.file.read_bytes()
            page.keyboard.press('1')
            expect_reply('single', single_reply)
            symbol = '.tree-node[data-node-id=single] .tree-symbol'
            expect(page.locator(symbol)).to_have_attribute('href', '#tree-flower')
            page.wait_for_function("document.querySelector('#mascot').naturalWidth > 0")
            page.wait_for_function('selector => !document.querySelector(selector).getAnimations().length', arg=symbol)
            page.screenshot(path=str(work / 'desktop-bloom-reply.png'))
            expect(dialog).to_have_attribute('data-node-id', 'multi')
            expect(mascot).to_have_attribute('src', '/mascot-ask.svg')
            delay = page.evaluate("window.flights.find(flight => flight.id === 'multi').at - window.answeredAt")
            assert delay >= 1400, delay

            confirm_choices()
            expect_reply('multi', multi_reply)
            expect(dialog).to_have_attribute('data-node-id', 'first-option')
            confirm_choices()
            expect_reply('first-option', first_reply)
            expect(dialog).to_have_attribute('data-node-id', 'text')
            page.get_by_role('textbox').fill('活动结束后一周。')
            page.keyboard.press('Control+Enter')
            expect_reply('text', text_reply)
            expect(dialog).to_have_attribute('data-node-id', 'no-first-reply')
            confirm_choices()
            expect_reply('no-first-reply')
            copies = [heading.inner_text()]
            assert copies[0] not in [choice['reply'] for choice in choices]
            for i in range(1, 5):
                expect(dialog).to_have_attribute('data-node-id', f'fallback-{i}')
                page.get_by_role('textbox').fill('这题有答案了。')
                page.keyboard.press('Control+Enter')
                expect_reply(f'fallback-{i}')
                copies.append(heading.inner_text())
            assert len(set(copies[:4])) == 4 and copies[0] == copies[4], copies
            expect(dialog).to_have_attribute('data-node-id', 'last')
            page.get_by_role('textbox').fill('齐了。')
            page.keyboard.press('Control+Enter')
            expect(dialog).to_be_hidden()
            expect(page.get_by_role('button', name='等等，我再看看')).to_be_focused()
            page.keyboard.press('Enter')
            expect(dialog).to_have_attribute('data-mode', 'summary')
            assert service.file.read_bytes() == before

            mobile = browser.new_page(viewport={'width': 320, 'height': 600}, reduced_motion='reduce')
            mobile.on('pageerror', lambda error: errors.append(str(error)))
            mobile.add_init_script(flight_probe)
            mobile.goto(service.url)
            mobile.get_by_role('button', name='先待定，以后再说').click()
            sheet = mobile.locator('#node-dialog')
            expect(sheet).to_have_attribute('data-mode', 'reply')
            expect(sheet).to_have_attribute('data-placement', 'sheet')
            expect(mobile.locator('#node-question')).to_have_text('记下了，先放一放。')
            expect(mobile.locator('.tree-node[data-node-id=single] .tree-symbol')).to_have_attribute('href', '#tree-deferred')
            assert sheet.evaluate('element => element.getAnimations().length') == 0
            no_overflow(mobile)
            mobile.screenshot(path=str(work / 'mobile-pause-reply.png'))
            expect(sheet).to_have_attribute('data-node-id', 'multi')
            assert mobile.evaluate('window.flights.length') == 0
            mobile.get_by_role('button', name='先待定，以后再说').click()
            expect(mobile.locator('#node-question')).to_have_text('这题留着，想好了再回来。')
            mobile.keyboard.press('Escape')
            expect(sheet).to_be_hidden()
            expect(mobile.locator('.tree-node[data-node-id=multi]')).to_be_focused()
            assert not errors, errors
            browser.close()
    finally:
        service.close()
    print('Mascot replies, fallback rotation, SVG assets, and reduced motion passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True, type=Path)
    run(parser.parse_args().work.resolve())
