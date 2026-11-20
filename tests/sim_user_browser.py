"""Exercise the simulator with a scripted AI and the real local grow-me service."""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from browser_acceptance import BASE, Service, node, request, seed


NOTE = '  邮件附上报名入口\n保留 <原文> 和空格  '
DEFERRED = '等场地回复\n再定日期'


def run(work):
    channels = node('channels', '首版需要哪些通知渠道？', options=[
        {'id': 'mail', 'label': '邮件'}, {'id': 'inbox', 'label': '站内通知'},
        {'id': 'none', 'label': '都不需要', 'exclusive': True},
    ])
    channels.update(input='multi_choice', recommendation={
        'option_ids': ['inbox'], 'reason': '站内通知便于回看。', 'source_ids': [],
    })
    service = Service(work / 'runtime', seed([channels, node('timing', '活动日期定在哪天？')]))
    children = []

    def post(path, payload):
        code, result = request(service.url, path, payload)
        assert code == 200, (path, code)
        return result

    def control(action, **fields):
        return post('/document/control', {'action': action, 'expected_revision': service.state()['revision'], **fields})

    def process(command):
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, encoding='utf-8')
        children.append(child)
        return child

    def start_wait():
        return process(['node', str(BASE / 'scripts/check.mjs'), '--wait', '--url', service.url,
                        '--session', session_id])

    def wait_receipt(child, kind):
        stdout, _ = child.communicate(timeout=25)
        assert child.returncode == 0, 'AI wait command failed'
        result = json.loads(stdout)
        assert [entry['kind'] for entry in result['events']] == [kind]
        return result

    try:
        session_id = service.state()['session_id']
        first_wait = start_wait()
        first_check = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            check = request(service.url, '/progress')[1]['ai']['last_check_at']
            if check is not None:
                if first_check is None:
                    first_check = check
                elif check >= first_check + 450:
                    break
            time.sleep(0.05)
        else:
            raise AssertionError('AI wait did not renew across three service idle deadlines')
        assert first_wait.poll() is None, 'AI wait woke before a user event'

        preset_file = work / 'answers.json'
        preset_file.write_text(json.dumps({'rounds': [
            {'reload_after': 1, 'answers': [
                {'deferred': True, 'text': DEFERRED},
                {'keyword': '通知渠道', 'options': ['邮件', 2], 'text': NOTE},
            ]},
            {'enough_after': 1, 'answers': [{'text': '先验收报名入口。'}]},
        ]}, ensure_ascii=False), encoding='utf-8')
        report_file = work / 'sim-user-report.json'
        user = process([sys.executable, str(BASE / 'tests/sim_user.py'), '--url', service.url,
                        '--answers', str(preset_file), '--state', str(service.file),
                        '--report', str(report_file), '--timeout', '50'])

        submitted = wait_receipt(first_wait, 'submit')
        assert submitted['revision'] == 1
        assert [n['answer'] for n in service.state()['nodes']] == [
            {'option_ids': ['mail', 'inbox'], 'text': NOTE},
            {'option_ids': [], 'text': DEFERRED, 'deferred': True},
        ]
        time.sleep(2.5)  # Leave two page polling intervals before changing the stage.
        post('/round', {'round': 2, 'expected_revision': 1, 'nodes': [
            node('followup', '如何验收报名入口？', deps=['channels'], round=2),
            node('extra', '还有哪些场地要求？', deps=['timing'], round=2),
        ]})
        plan = wait_receipt(start_wait(), 'request_plan')
        assert plan['plan_requested']
        assert service.state()['nodes'][-1]['answer'] == {'option_ids': [], 'text': '', 'deferred': True}
        time.sleep(2.5)
        control('offer')
        wait_receipt(start_wait(), 'save')

        status = request(service.url, '/document/status')[1]
        control('claim', job_id=status['job_id'])
        status = request(service.url, '/document/status')[1]
        context_file = work / 'writer-context.json'
        context_file.write_text(json.dumps(status, ensure_ascii=False), encoding='utf-8')
        parts = work / 'parts'
        parts.mkdir(exist_ok=True)
        source = {key: status['source'][key] for key in ('session_id', 'revision', 'digest')}
        source['job_id'] = status['job_id']

        def part(name, view, html, **fields):
            (parts / f'{name}.json').write_text(json.dumps({
                'source': source, 'view': view, 'html': html, **fields,
            }, ensure_ascii=False), encoding='utf-8')

        def compose(preview):
            command = ['node', str(BASE / 'scripts/compose-document.mjs'), '--context', str(context_file),
                       '--tree', str(service.file), '--parts', str(parts)]
            if preview:
                command.extend(['--preview', '--url', service.url])
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=10)
            assert result.returncode == 0, 'scripted AI could not assemble the document'

        for index, chapter in enumerate(status['source']['chapters'], 1):
            part(f'chapter-{index}', 'chapter', '<p>离线自测章节</p>', chapter_id=chapter['id'])
            compose(preview=True)
            time.sleep(2.5)  # Allow each newly published fruit to appear before publishing another.
        part('design', 'design', '<article id="R1" data-kind="requirement"><h3>报名入口</h3></article>')
        part('plan', 'plan', '<article id="W1" data-kind="work" data-requirements="R1" data-criteria="AC1">'
             '<h3>开发报名入口</h3><span data-field="status">planned</span><a href="#AC1">验收</a></article>')
        part('acceptance', 'acceptance', '<article id="AC1" data-kind="criterion" data-requirements="R1">'
             '<h3>验收报名入口</h3><span data-field="status">unverified</span><a href="#R1">需求</a></article>')
        compose(preview=False)
        control('ready', job_id=status['job_id'])

        stdout, _ = user.communicate(timeout=15)
        report = json.loads(report_file.read_text(encoding='utf-8'))
        assert user.returncode == 0 and report['status'] == 'completed', report
        assert '已提交 2 轮' in stdout
        first, second = report['rounds']
        assert first['kind'] == 'submit' and first['answered_from_preset'] == 2
        assert second['kind'] == 'request_plan' and second['automatically_deferred'] == 1
        assert all(item['discovery_delay_ms'] >= 0 for item in [first, second])
        checks = report['checks']
        assert checks['recommendation_preselected']['observations'] == [
            {'round': 1, 'position': 1, 'preselected': False},
        ]
        assert checks['answers_unchanged'] == {'status': '通过', 'expected': 4, 'checked': 4, 'changed': 0}
        assert checks['draft_survives_reload']['reloads'] == [{'round': 1, 'drafts': 1, 'restored': True}]
        assert checks['chapters_published_sequentially']['visible_preview_counts'] == [1, 2]
        assert checks['false_pause_during_questions']['notices'] == 0
        assert checks['submission_discovery']['status'] == '已测'
        assert checks['idle_wait_false_wakeups']['status'] == '未测'
        for name in ['recommendation_preselected', 'draft_survives_reload',
                     'chapters_published_sequentially', 'false_pause_during_questions', 'ai_work_online']:
            assert checks[name]['status'] == '通过', checks[name]
        assert NOTE not in stdout and service.url not in stdout
        assert '保留 <原文>' not in report_file.read_text(encoding='utf-8')
        print(json.dumps({'status': 'passed', 'rounds': 2, 'scripted_idle_wakeups': 0}))
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=5)
        service.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    run(parser.parse_args().work.resolve())
