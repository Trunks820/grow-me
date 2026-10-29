"""Different requirements vary; reload/replay stay stable; real 28-node hit tests."""
from pathlib import Path
import argparse, hashlib, json, subprocess, sys, tempfile
sys.dont_write_bytecode = True
from browser_acceptance import BASE, Service, request, document_fixture
from playwright.sync_api import sync_playwright, expect
sys.stdout.reconfigure(encoding='utf-8')

def shape(page):
    return page.locator('#tree-canvas').evaluate('''s=>({
      branches:[...s.querySelectorAll('.tree-branch')].map(n=>n.getAttribute('d')),
      nodes:[...s.querySelectorAll('.tree-node')].map(n=>[n.dataset.nodeId,n.getAttribute('transform')]),
      fruits:[...s.querySelectorAll('.tree-fruit')].map(n=>[n.dataset.fruitId,n.getAttribute('transform')])
    })''')

def geometry(page):
    return page.locator('#tree-canvas').evaluate('''s=>{
      const b=s.getBoundingClientRect(),items=[...s.querySelectorAll('.tree-node use,.fruit-body')];
      const boxes=items.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}),overlaps=[];
      for(let i=0;i<boxes.length;i++)for(let j=0;j<i;j++){const a=boxes[i],b=boxes[j];if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>.4&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>.4)overlaps.push([i,j]);}
      return{overlaps,within_canvas:boxes.every(r=>r.x>=b.x-1&&r.y>=b.y-1&&r.x+r.w<=b.right+1&&r.y+r.h<=b.bottom+1)};
    }''')

def chapter_clicks(page,service,expected):
    clicks=[]
    for index,fruit in enumerate(page.locator('.tree-fruit').all()):
      root=fruit.get_attribute('data-fruit-id')
      with page.expect_popup() as info:fruit.locator('.fruit-hit').click()
      popup=info.value;popup.wait_for_load_state()
      assert popup.viewport_size==page.viewport_size,(popup.viewport_size,page.viewport_size)
      assert popup.url.endswith('/document#'+expected[root]['anchor'])
      target=popup.locator('#'+expected[root]['anchor'])
      expect(target.locator('h2')).to_have_text(expected[root]['title'])
      top=target.bounding_box()['y'];scroll=popup.evaluate('scrollY')
      assert -1<=top<=page.viewport_size['height']*.25,(root,top)
      if index:assert scroll>0,'Later chapters must really scroll into view'
      clicks.append({'root':root,'anchor':expected[root]['anchor'],'target_top_px':round(top,2),'scroll_y':scroll})
      popup.close()
    assert len(clicks)==len(expected)
    return clicks

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--work', required=True); args=parser.parse_args()
    out=Path(args.work).resolve(); out.mkdir(parents=True,exist_ok=True)
    report={'kind':'Requirement-id + node-id bounded growth, synthetic 28-question browser acceptance','checks':{},'cases':{},'errors':[]}
    services=[];runtime=Path(tempfile.mkdtemp(prefix='runtime-',dir=out))
    try:
      with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for factory in ['specimen28','specimen28FourRounds']:
          original=json.loads(subprocess.check_output(['node','--input-type=module','-e','import{'+factory+'}from '+json.dumps((BASE/'tests/fixtures.mjs').as_uri())+';console.log(JSON.stringify('+factory+'()))'],text=True,encoding='utf-8'))
          fingerprints=[]
          for name in ['A','B']:
            tree=json.loads(json.dumps(original));tree['session_id']='requirement-'+name;tree['status']='complete'
            tree['topic']='同一组 28 题 · 需求 '+name
            key=factory+'-'+name;service=Service(runtime/key,tree);services.append(service)
            before=hashlib.sha256(service.file.read_bytes()).hexdigest()
            code,status=request(service.url,'/document/control',{'action':'retry','expected_revision':0});assert code==200
            assert request(service.url,'/document/control',{'action':'claim','expected_revision':0,'job_id':status['job_id']})[0]==200
            document=Path(service.startup['document_file']);document.parent.mkdir(parents=True,exist_ok=True)
            content=document_fixture(status).replace('<main ','<style>body{margin:0}#design-view>article{min-height:720px;padding:24px;box-sizing:border-box}h2{margin-top:0}</style><main ',1)
            document.write_text(content,encoding='utf-8')
            assert request(service.url,'/document/control',{'action':'ready','expected_revision':0,'job_id':status['job_id']})[0]==200
            page=browser.new_page(viewport={'width':1440,'height':900});page.emulate_media(reduced_motion='reduce')
            page.on('pageerror',lambda error:report['errors'].append(str(error)))
            page.goto(service.url);page.wait_for_load_state('networkidle')
            expect(page.locator('.tree-node')).to_have_count(28)
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false')
            baseline=shape(page);signature=hashlib.sha256(json.dumps(baseline,sort_keys=True).encode()).hexdigest();fingerprints.append(signature)
            case={'question_count':28,'geometry_sha256':signature,'viewports':{}}
            page.reload();page.wait_for_load_state('networkidle');assert shape(page)==baseline
            case['refresh_stable']=True
            # Replay the actual growth with a controlled browser clock; compare
            # the settled paths, not screenshots taken during an animation.
            page.clock.install();page.emulate_media(reduced_motion='no-preference')
            page.get_by_role('button',name='重看生长',exact=True).click()
            page.clock.fast_forward(25000);page.clock.fast_forward(1000)
            expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false')
            assert shape(page)==baseline;case['replay_stable']=True
            page.emulate_media(reduced_motion='reduce')
            expected={c['id']:c for c in request(service.url,'/document/status')[1]['source']['chapters']}
            for width,height,label in [(1440,900,'desktop'),(1000,900,'compact'),(390,844,'mobile')]:
              if label=='mobile':
                page.close();page=browser.new_page(viewport={'width':width,'height':height});page.emulate_media(reduced_motion='reduce')
                page.on('pageerror',lambda error:report['errors'].append(str(error)))
                page.goto(service.url);page.wait_for_load_state('networkidle')
                expect(page.locator('#tree-canvas')).to_have_attribute('data-growing','false')
                assert shape(page)==baseline
              page.set_viewport_size({'width':width,'height':height})
              page.evaluate("window.clickLog=[];document.addEventListener('click',e=>window.clickLog.push({id:e.target.closest('.tree-node')?.dataset.nodeId,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true)")
              metrics=geometry(page);assert not metrics['overlaps'] and metrics['within_canvas'],(key,label,metrics)
              assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
              for target in page.locator('.tree-node').all():
                node_id=target.get_attribute('data-node-id');target.click()
                try:expect(page.locator('#node-question')).to_have_text(next(n['question'] for n in tree['nodes'] if n['id']==node_id))
                except Exception:
                  page.screenshot(path=str(out/(key+'-'+label+'-failure.png')),full_page=True)
                  report['failure_context']={'case':key,'viewport':label,'node':node_id,'clicks':page.evaluate('window.clickLog'),'box':target.bounding_box()}
                  raise
                page.get_by_role('button',name='关闭',exact=True).click()
              case['viewports'][label]={**metrics,'question_clicks':28}
              if label!='compact':case['viewports'][label]['chapter_clicks']=chapter_clicks(page,service,expected)
              if label!='compact':page.screenshot(path=str(out/(key+'-'+label+'.png')),full_page=True)
            page.set_viewport_size({'width':1440,'height':900})
            fruit=page.locator('.tree-fruit').first;root=fruit.get_attribute('data-fruit-id');fruit.focus()
            with page.expect_popup() as info:page.keyboard.press('Enter')
            popup=info.value;popup.wait_for_load_state();assert popup.url.endswith('#'+expected[root]['anchor']);popup.close()
            case['keyboard_chapter_navigation']=True
            case['state_unchanged']=before==hashlib.sha256(service.file.read_bytes()).hexdigest();assert case['state_unchanged']
            page.get_by_role('button',name='结束预览',exact=True).click();assert service.child.wait(timeout=5)==0
            case['status']='passed';report['cases'][key]=case;page.close()
          assert fingerprints[0]!=fingerprints[1], 'Different requirement ids grew identical paths'
          report['checks'][factory+'_requirements_differ']=True
        browser.close()
    except Exception as error:
      report['errors'].append(str(error))
    finally:
      for service in services:service.close()
      report['status']='passed' if len(report['cases'])==4 and not report['errors'] and all(report['checks'].values()) else 'failed'
      (out/'seeded-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':report['status'],'checks':report['checks'],'cases':list(report['cases']),'errors':report['errors']},ensure_ascii=False,indent=2))
    raise SystemExit(0 if report['status']=='passed' else 1)

if __name__=='__main__':main()
