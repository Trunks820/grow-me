"""Visual stages of one synthetic six-round requirement; no model or user data."""
from pathlib import Path
import argparse, hashlib, json, subprocess, tempfile
from browser_acceptance import BASE, Service, request, document_fixture
from seeded_growth import shape, geometry
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    parser.add_argument('--reference', type=Path, help='Optional original v7 HTML, read only')
    args = parser.parse_args()
    out = Path(args.work).resolve()
    out.mkdir(parents=True, exist_ok=True)
    runtime = Path(tempfile.mkdtemp(prefix='runtime-', dir=out))
    original = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        'import{specimen28}from '+json.dumps((BASE/'tests/fixtures.mjs').as_uri())+';console.log(JSON.stringify(specimen28()))'], encoding='utf-8'))
    report = {'kind': 'Synthetic six-round, 28-question visual acceptance', 'stages': {}, 'errors': []}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for round in [1, 2, 4, 6]:
            tree = json.loads(json.dumps(original))
            tree['nodes'] = [n for n in tree['nodes'] if n['round'] <= round]
            tree['current_round'] = round
            if round == 6:
                tree['status'] = 'complete'
            service = Service(runtime / str(round), tree)
            try:
                before = hashlib.sha256(service.file.read_bytes()).hexdigest()
                if round == 6:
                    code, status = request(service.url, '/document/control', {'action': 'retry', 'expected_revision': 0})
                    assert code == 200
                    assert request(service.url, '/document/control', {'action': 'claim', 'expected_revision': 0, 'job_id': status['job_id']})[0] == 200
                    document = Path(service.startup['document_file'])
                    document.parent.mkdir(parents=True, exist_ok=True)
                    document.write_text(document_fixture(status), encoding='utf-8')
                    assert request(service.url, '/document/control', {'action': 'ready', 'expected_revision': 0, 'job_id': status['job_id']})[0] == 200
                page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
                page.on('pageerror', lambda error: report['errors'].append(str(error)))
                page.goto(service.url)
                page.wait_for_load_state('networkidle')
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false')
                baseline = shape(page)
                metrics = geometry(page)
                assert not metrics['overlaps'] and metrics['within_canvas'], metrics
                drawing = page.evaluate('''async tree=>{
                  const {layoutTree,cameraFrame,trunkGeometry}=await import('/tree.mjs'),layout=layoutTree(tree);
                  const canvas=document.querySelector('#tree-canvas').getBoundingClientRect(),wood=document.querySelector('.tree-wood').getBoundingClientRect();
                  const washes=[...document.querySelectorAll('.tree-wash')].map(n=>({width:n.getBBox().width,height:n.getBBox().height,opacity:Number(n.getAttribute('opacity'))}));
                  return {trunk_width:trunkGeometry(layout,tree.current_round).baseWidth,ink_height_ratio:layout.paintBounds.height/cameraFrame(tree,layout).height,rendered_wood_height_ratio:wood.height/canvas.height,washes};
                }''', tree)
                assert drawing['ink_height_ratio'] <= .75+1e-8
                assert drawing['rendered_wood_height_ratio'] <= .75+1e-8
                assert drawing['washes'] and all(w['width'] < 130 and w['height'] < 120 and 0 < w['opacity'] <= .16 for w in drawing['washes'])
                assert page.locator('#tree-canvas text').count() == 0
                page.locator('#tree-canvas').screenshot(path=str(out / f'round-{round}.png'))
                page.screenshot(path=str(out / f'round-{round}-page.png'), full_page=True)
                page.reload()
                page.wait_for_load_state('networkidle')
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing', 'false')
                assert shape(page) == baseline
                page.locator('#tree-canvas').screenshot(path=str(out / f'round-{round}-reload.png'))
                assert (out / f'round-{round}.png').read_bytes() == (out / f'round-{round}-reload.png').read_bytes()
                assert before == hashlib.sha256(service.file.read_bytes()).hexdigest()
                report['stages'][round] = {'question_count': len(tree['nodes']), 'reload_geometry_identical': True,
                    'reload_pixels_identical': True, 'state_unchanged': True, **metrics, **drawing}
                page.close()
            finally:
                service.close()
        if args.reference:
            reference = args.reference.resolve()
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            page.goto(reference.as_uri()+'?r=6&a=3&fin=1')
            page.wait_for_load_state('networkidle')
            expect(page.locator('#meta')).to_contain_text('28 / 28')
            page.locator('#s').screenshot(path=str(out / 'v7-round-6.png'))
            ratio = page.locator('#s').evaluate('s=>s.firstElementChild.getBoundingClientRect().height/s.getBoundingClientRect().height')
            report['reference'] = {'file': str(reference), 'sha256': hashlib.sha256(reference.read_bytes()).hexdigest(), 'rendered_height_ratio': ratio, 'note': 'Original static prototype, not production interview data'}
            comparison = out / 'v7-comparison.html'
            comparison.write_text('''<!doctype html><meta charset="utf-8"><title>v7 与当前树形对比</title>
<style>body{margin:0;background:#efe9dc;color:#625b4e;font-family:Georgia,"SimSun",serif}main{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px}figure{margin:0}figcaption{font-size:20px;text-align:center;padding:8px 0 20px}img{display:block;width:100%;height:780px;object-fit:contain}small{display:block;font-size:13px;margin-top:8px}</style>
<main><figure><figcaption>v7 参考<small>6 轮 · 28 题</small></figcaption><img src="v7-round-6.png"></figure><figure><figcaption>当前绘制<small>6 轮 · 28 题</small></figcaption><img src="round-6.png"></figure></main>''', encoding='utf-8')
            page.set_viewport_size({'width': 1660, 'height': 900})
            page.goto(comparison.as_uri())
            page.wait_for_load_state('networkidle')
            page.screenshot(path=str(out / 'v7-comparison.png'), full_page=True)
            page.close()
        browser.close()
    assert not report['errors'], report['errors']
    report['status'] = 'passed'
    (out / 'tree-shape-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
