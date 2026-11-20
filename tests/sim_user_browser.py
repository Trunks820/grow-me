"""Exercise the simulator with a scripted AI and the real local grow-me service."""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from browser_acceptance import BASE, Service, document_fixture, node, request, seed
from sim_user import SimUser, page_target


NOTE = '  邮件附上报名入口\n保留 <原文> 和空格  '
DEFERRED = '等场地回复\n再定日期'
UNCLEAR = '我想看个例子。'


def wait_receipt(child, kind):
    stdout, _ = child.communicate(timeout=25)
    assert child.returncode == 0, 'AI wait command failed'
    result = json.loads(stdout)
    assert [entry['kind'] for entry in result['events']] == [kind]
    return result


def run(work):
    channels = node('channels', '首版需要哪些通知渠道？', options=[
        {'id': 'mail', 'label': '邮件'}, {'id': 'inbox', 'label': '站内通知'},
        {'id': 'none', 'label': '都不需要', 'exclusive': True},
    ])
    channels.update(input='multi_choice', recommendation={
        'option_ids': ['inbox'], 'reason': '站内通知便于回看。', 'source_ids': [],
    })
    timing = node('timing', '活动日期定在哪天？', options=[
        {'id': 'sat', 'label': '周六'}, {'id': 'sun', 'label': '周日'},
    ])
    service = Service(work / 'runtime', seed([channels, timing]))
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
                {'deferred': True, 'options': ['周六'], 'text': DEFERRED},
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
            {'option_ids': ['sat'], 'text': DEFERRED, 'deferred': True},
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


def run_auto_and_find(work):
    work.mkdir(parents=True, exist_ok=True)
    channels = node('channels', '需要哪些通知渠道？', options=[
        {'id': 'mail', 'label': '邮件'}, {'id': 'inbox', 'label': '站内通知'},
        {'id': 'push', 'label': '推送'},
    ])
    channels.update(input='multi_choice', recommendation={
        'option_ids': ['inbox', 'push'], 'reason': '站内通知和推送便于跟进。', 'source_ids': [],
    })
    priority = node('priority', '怎么安排首版？', options=[
        {'id': 'skip', 'label': '都不做', 'exclusive': True},
        {'id': 'basic', 'label': '先做基础版'}, {'id': 'full', 'label': '直接做完整版'},
    ])
    priority['input'] = 'multi_choice'
    followup = node('check', '怎样验收？', deps=['channels'], round=2, options=[
        {'id': 'sample', 'label': '抽样验证'}, {'id': 'all', 'label': '逐项验证'},
    ])
    followup['recommendation'] = {
        'option_ids': ['all'], 'reason': '两种通知渠道都要核对。', 'source_ids': ['channels'],
    }
    followup.update(question='报名入口做完后，怎么检查它能用？', rephrases='details')
    tree = seed([channels, node('date', '何时上线？'), node('details', '报名入口需要补充哪些验收要求？'),
                 priority, node('venue', '场地在哪里？')])
    preset_file = work / 'answers.json'
    preset_file.write_text(json.dumps({'rounds': [
        {'reload_after': 1, 'answers': [
            {'options': [99]}, {'text': '先覆盖报名。'},
            {'keyword': '通知渠道', 'options': [1], 'text': NOTE},
            {'keyword': '补充哪些验收要求', 'unclear': True, 'text': UNCLEAR},
            {'keyword': '场地', 'deferred': True, 'options': [99], 'text': DEFERRED},
        ]},
        {'enough_after': 1, 'answers': [{'text': '验收报名。'}, {'options': [99]}, {'text': '多余预设'}]},
    ]}, ensure_ascii=False), encoding='utf-8')
    report_file = work / 'sim-user-report.json'
    user = subprocess.Popen([
        sys.executable, str(BASE / 'tests/sim_user.py'), '--auto', '--find', str(work),
        '--find-timeout', '15', '--answers', str(preset_file), '--report', str(report_file),
        '--timeout', '40',
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    service = None

    def wait(kind):
        command = ['node', str(BASE / 'scripts/check.mjs'), '--wait', '--url', service.url,
                   '--session', tree['session_id']]
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding='utf-8') as child:
            try:
                return wait_receipt(child, kind)
            finally:
                if child.poll() is None:
                    child.terminate()

    def post(path, **payload):
        code, result = request(service.url, path, {'expected_revision': service.state()['revision'], **payload})
        assert code == 200, (path, code)
        return result

    try:
        time.sleep(1)
        assert user.poll() is None, 'simulator exited before the service started'
        service = Service(work / 'runtime', tree)
        # Service runs under a managed child in browser tests. Mirror its stdout in a startup log.
        (service.work / '.grow-me-server-test.log').write_text(
            'starting\n' + json.dumps(service.startup) + '\n', encoding='utf-8',
        )
        wait('submit')
        assert [n['answer'] for n in service.state()['nodes']] == [
            {'option_ids': ['inbox', 'push'], 'text': NOTE},
            {'option_ids': [], 'text': '按你推荐的来，先做最小可用的版本。'},
            {'option_ids': [], 'text': UNCLEAR, 'unclear': True},
            {'option_ids': ['basic'], 'text': '先覆盖报名。'},
            {'option_ids': [], 'text': DEFERRED, 'deferred': True},
        ]
        post('/round', round=2, nodes=[followup, node('extra', '还有什么要确认？', round=2)])
        wait('request_plan')
        assert [n['answer'] for n in service.state()['nodes'][-2:]] == [
            {'option_ids': ['all'], 'text': '验收报名。'},
            {'option_ids': [], 'text': '', 'deferred': True},
        ]
        post('/document/control', action='offer')
        wait('save')
        status = request(service.url, '/document/status')[1]
        post('/document/control', action='claim', job_id=status['job_id'])
        output = Path(service.startup['document_file'])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(document_fixture(status), encoding='utf-8')
        post('/document/control', action='ready', job_id=status['job_id'])

        user.communicate(timeout=15)
        report = json.loads(report_file.read_text(encoding='utf-8'))
        assert user.returncode == 0 and report['status'] == 'completed', report
        assert [entry['kind'] for entry in report['rounds']] == ['submit', 'request_plan']
        assert report['checks']['draft_survives_reload']['status'] == '通过'
        assert report['checks']['submission_discovery']['status'] == '已测'
        assert report['checks']['unclear_rephrased'] == {
            'status': '通过', 'observations': [{'round': 2, 'linked': True, 'rewritten': True}],
        }
        tree = service.state()
        old = next(n for n in tree['nodes'] if n['id'] == 'details')
        rephrased = next(n for n in tree['nodes'] if n['id'] == 'check')
        rephrased['question'] = old['question']
        sim = SimUser(page_target(service.url), [], None)
        sim.check_rephrases(tree)
        del rephrased['rephrases']
        sim.check_rephrases(tree)
        assert sim.score()['checks']['unclear_rephrased'] == {
            'status': '失败',
            'observations': [
                {'round': 2, 'linked': True, 'rewritten': False},
                {'round': 2, 'linked': False, 'rewritten': False},
            ],
        }
        print(json.dumps({'status': 'passed', 'auto': True, 'find': True}))
    finally:
        if user.poll() is None:
            user.terminate()
            user.communicate(timeout=5)
        if service:
            service.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    work = parser.parse_args().work.resolve()
    run(work)
    run_auto_and_find(work / 'auto-find')
