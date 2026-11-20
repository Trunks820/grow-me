"""Check the saved chapter grid and its matching fruit at desktop and phone sizes."""

import argparse
from pathlib import Path
from tempfile import mkdtemp

from playwright.sync_api import expect, sync_playwright

from browser_acceptance import Service, capture, document_fixture, no_overflow, node, request, seed


TITLES = [
    '等 AI 回复时，页面上要显示什么？',
    '答到一半关掉页面，再回来时怎么接着答？',
    '每一轮的问题由谁来确定？',
    '提交前怎么回看和修改这一轮的答案？',
    '方案生成得慢时，可以先看哪些内容？',
    '这一版做到什么程度算完成？',
    '没想好的问题怎么记下来，之后从哪里补上答案？',
    '已经写好的章节怎样和原来的问题对应起来？',
    '分享方案给其他人时，他们需要看到哪些内容才能接着做？',
    '旧答案改了以后，怎么知道有哪些后续决定也要重新确认？',
    '很长的英文标识 ' + 'CompletedChapterTitleThatMustWrap' * 3 + ' 怎么显示？',
    '验收时怎样检查最后一项也能用键盘打开？',
]


def exercise(page, service, chapters, columns, out, label):
    page.goto(service.url)
    expect(page.get_by_role('heading', name='问过的，都结成了果。')).to_be_visible()
    expect(page.get_by_text(
        f'{len(chapters)} 颗果子＝方案的 {len(chapters)} 章，点果子或章名都能打开',
        exact=True,
    )).to_be_visible()
    expect(page.locator('#completion-mascot')).to_be_visible()
    expect(page.locator('#completion-mascot')).to_have_attribute('src', '/mascot-bloom.svg')
    page.wait_for_function("document.querySelector('#completion-mascot').naturalWidth > 0")
    expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false')

    grid = page.locator('.chapters')
    entries = grid.get_by_role('link')
    fruits = page.locator('.tree-fruit')
    expect(entries).to_have_count(len(chapters))
    expect(fruits).to_have_count(len(chapters))
    assert fruits.evaluate_all("""fruits => fruits.every(fruit => {
        const {x, y, width, height} = fruit.querySelector('.fruit-body').getBoundingClientRect();
        return document.elementFromPoint(x + width / 2, y + height / 2)
            ?.closest('.tree-fruit') === fruit;
    })"""), 'A fruit is covered at its center'
    assert grid.evaluate("grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length") == columns
    assert grid.evaluate("""grid => {
        const card = grid.closest('#card');
        const rect = grid.getBoundingClientRect();
        return card.scrollHeight === card.clientHeight &&
            rect.bottom <= card.getBoundingClientRect().bottom &&
            [...grid.querySelectorAll('.chapter-title')].every(title => {
                const text = document.createRange();
                text.selectNodeContents(title);
                const row = title.closest('a').getBoundingClientRect();
                return [...text.getClientRects()].every(line =>
                    line.left >= row.left && line.right <= row.right &&
                    line.top >= row.top && line.bottom <= row.bottom);
            });
    }"""), 'The card or title text clips a chapter'
    no_overflow(page)

    for i, chapter in enumerate(chapters):
        entry, fruit = entries.nth(i), fruits.nth(i)
        expect(entry.locator('.chapter-number')).to_have_text(str(i + 1))
        expect(entry.locator('.chapter-title')).to_have_text(chapter['title'])
        expect(entry).to_have_attribute('href', '/document#' + chapter['anchor'])
        expect(fruit).to_have_attribute('data-fruit-id', chapter['id'])
        expect(fruit.locator('title')).to_have_text(f"打开章节：第 {i + 1} 章 · {chapter['title']}")
        expect(fruit.locator('.fruit-number')).to_have_text(str(i + 1))
        expect(fruit.locator('.fruit-body')).to_have_attribute('r', '9')
        expect(fruit.locator('.fruit-growth')).to_have_attribute('transform', 'scale(1)')

    last = entries.last
    capture(page, out, label)
    if columns == 2:
        box = grid.bounding_box()
        assert 0 <= box['y'] <= box['y'] + box['height'] <= page.viewport_size['height'], box
        fruits.last.locator('.fruit-body').hover()
        assert fruits.last.evaluate("fruit => fruit.matches(':hover')")
        page.mouse.move(0, 0)

    fruits.last.focus()
    expect(fruits.last).to_be_focused()
    with page.expect_popup() as opened:
        page.keyboard.press('Space')
    assert opened.value.url.endswith('/document#' + chapters[-1]['anchor'])
    opened.value.close()

    entries.first.focus()
    expect(entries.first).to_be_focused()
    for i in range(1, len(chapters)):
        page.keyboard.press('Tab')
        expect(entries.nth(i)).to_be_focused()
        expect(entries.nth(i)).to_be_in_viewport(ratio=0.99)
    with page.expect_popup() as opened:
        page.keyboard.press('Enter')
    assert opened.value.url.endswith('/document#' + chapters[-1]['anchor'])
    opened.value.close()
    page.keyboard.press('Tab')
    full = page.get_by_role('link', name='打开完整方案', exact=True)
    expect(full).to_be_focused()
    expect(full).to_be_in_viewport(ratio=1)
    assert last.bounding_box()['y'] + last.bounding_box()['height'] <= full.bounding_box()['y']
    with page.expect_popup() as opened:
        page.keyboard.press('Enter')
    assert opened.value.url.endswith('/document')
    opened.value.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    out = parser.parse_args().work.resolve()
    out.mkdir(parents=True, exist_ok=True)
    runtime = Path(mkdtemp(prefix='runtime-', dir=out))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for count in (6, 12):
            rounds = count // 3
            tree = seed([
                node(f'chapter-{i + 1}', title, round=i // 3 + 1, answered=True)
                for i, title in enumerate(TITLES[:count])
            ], round=rounds)
            tree.update(status='complete', session_id=f'completion-{count}')
            service = Service(runtime / str(count), tree)
            try:
                code, status = request(service.url, '/document/control', {
                    'action': 'retry', 'expected_revision': 0,
                })
                assert code == 200
                job = {'job_id': status['job_id'], 'expected_revision': 0}
                assert request(service.url, '/document/control', {'action': 'claim', **job})[0] == 200
                document = Path(service.startup['document_file'])
                document.parent.mkdir(parents=True, exist_ok=True)
                document.write_text(document_fixture(status), encoding='utf-8')
                assert request(service.url, '/document/control', {'action': 'ready', **job})[0] == 200
                for width, height, columns in [(1280, 860, 2), (390, 844, 1)]:
                    page = browser.new_page(
                        viewport={'width': width, 'height': height}, reduced_motion='reduce',
                    )
                    label = f'completion-{count}-{width}x{height}'
                    exercise(page, service, status['source']['chapters'], columns, out, label)
                    page.close()
                    print(f'{label} passed')
            finally:
                service.close()
        browser.close()


if __name__ == '__main__':
    main()
