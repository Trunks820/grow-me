"""Answer a grow-me interview in Chromium using a JSON preset."""

import argparse
import asyncio
import json
import math
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import Error as PlaywrightError, async_playwright


PASSED, FAILED, UNTESTED, MEASURED = '通过', '失败', '未测', '已测'
CHECKS = {
    'recommendation_preselected': '推荐是否预选',
    'answers_unchanged': '提交答案是否保持原样',
    'draft_survives_reload': '刷新保留草稿',
    'chapters_published_sequentially': '章节逐章发布',
    'submission_discovery': 'AI 首次发现提交的延迟',
    'false_pause_during_questions': '出题期间暂停误报',
    'heartbeat_continuity': 'AI 工作期间心跳',
    'idle_wait_false_wakeups': '等待上限白叫醒',
}


class ScenarioError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ScenarioError(message)


def read_preset(path):
    preset = json.loads(path.read_text(encoding='utf-8-sig'))
    require(isinstance(preset, dict) and set(preset) == {'rounds'}, '预设需要 rounds 数组。')
    rounds = preset['rounds']
    require(isinstance(rounds, list) and rounds, 'rounds 至少需要一项。')
    for number, plan in enumerate(rounds, 1):
        prefix = f'第 {number} 轮预设'
        require(isinstance(plan, dict) and plan.keys() <= {'answers', 'reload_after', 'enough_after'},
                f'{prefix}字段无效。')
        for key, minimum in [('reload_after', 1), ('enough_after', 0)]:
            if key in plan:
                require(type(plan[key]) is int and plan[key] >= minimum, f'{prefix}的 {key} 无效。')
        if 'reload_after' in plan and 'enough_after' in plan:
            require(plan['reload_after'] <= plan['enough_after'], f'{prefix}须在喊够了之前刷新。')
        answers = plan.get('answers', [])
        require(isinstance(answers, list), f'{prefix}需要 answers 数组。')
        for answer in answers:
            require(isinstance(answer, dict) and answer.keys() <= {'keyword', 'options', 'text', 'deferred'},
                    f'{prefix}的答案字段无效。')
            options = answer.get('options', [])
            require(isinstance(options, list) and all(
                (type(item) is int and item > 0) or (isinstance(item, str) and item.strip())
                for item in options), f'{prefix}的选项须为标签或从 1 起的序号。')
            require(isinstance(answer.get('text', ''), str) and type(answer.get('deferred', False)) is bool
                    and ('keyword' not in answer or isinstance(answer['keyword'], str)
                         and answer['keyword'].strip()), f'{prefix}的答案类型无效。')
    return rounds


def match_answers(nodes, presets, number):
    matches, positional = {}, []
    for preset in presets:
        keyword = preset.get('keyword')
        if not keyword:
            positional.append(preset)
            continue
        ids = [node['id'] for node in nodes if keyword.casefold() in node['question'].casefold()]
        require(len(ids) == 1 and ids[0] not in matches,
                f'第 {number} 轮有关键词无匹配、匹配多题或重复匹配同一题。')
        matches[ids[0]] = preset
    remaining = [node['id'] for node in nodes if node['id'] not in matches]
    require(len(positional) <= len(remaining), f'第 {number} 轮的顺序预设多于剩余题目。')
    matches.update(zip(remaining, positional))
    return matches


def expected_answer(node, preset, description):
    selected = set()
    for entry in preset.get('options', []):
        options = node['options']
        if type(entry) is int:
            matches = options[entry - 1:entry]
        else:
            matches = [option for option in options if option['label'] == entry]
        require(len(matches) == 1 and matches[0]['id'] not in selected,
                f'{description}的选项无匹配、标签重复或重复选择。')
        selected.add(matches[0]['id'])
    text = preset.get('text', '').replace('\r\n', '\n').replace('\r', '\n')
    answer = {'option_ids': [o['id'] for o in node['options'] if o['id'] in selected], 'text': text}
    if preset.get('deferred'):
        answer['deferred'] = True
    elif node['input'] == 'text':
        require(text.strip(), f'{description}须填写正文或设为待定。')
    elif node['input'] == 'single_choice':
        require(len(selected) == 1, f'{description}须选择一项。')
    else:
        require(selected, f'{description}须选择至少一项。')
    require(len(selected) < 2 or not any(o.get('exclusive') and o['id'] in selected for o in node['options']),
            f'{description}的互斥选项须单独选择。')
    return answer


def epoch_ms():
    return int(time.time() * 1000)


def answer_matches(actual, expected):
    return isinstance(actual, dict) and (
        actual.get('text') == expected['text']
        and actual.get('option_ids') == expected['option_ids']
        and actual.get('deferred', False) == expected.get('deferred', False)
    )


# Observe pause transitions even between Playwright actions. Render may replace the
# notice without clearing it, so track presence rather than counting inserted nodes.
WATCH_PAUSES = """
window.simUserPauses = [];
document.addEventListener('DOMContentLoaded', () => {
    const card = document.querySelector('#card');
    if (!card) return;
    let shown = false;
    new MutationObserver(() => {
        const notice = card.querySelector('#ai-wait-notice');
        const visible = !!notice && notice.getClientRects().length > 0;
        if (visible && !shown) window.simUserPauses.push({
            revision: Number(document.querySelector('#meta').dataset.revision),
            observed_at: Date.now()
        });
        shown = visible;
    }).observe(card, {subtree: true, childList: true});
}, {once: true});
"""


class SimUser:
    def __init__(self, url, rounds, state_file):
        target = urlsplit(url)
        require(target.scheme in ('http', 'https') and target.hostname and not target.username
                and not target.password, '需要可在 Chromium 打开的 HTTP(S) 网页地址。')
        self.url = url
        self.origin = self.origin_of(target)
        self.plans = rounds
        self.state_file = state_file
        self.tree = None
        self.document = None
        self.progress = []
        self.pauses = []
        self.submissions = []
        self.expected = {}
        self.answer_checks = {}
        self.recommendations = []
        self.reloads = []
        self.chapter_steps = []
        self.save_revision = None
        self.identity_changed = False
        self.page_errors = 0
        self.step = '启动 Chromium'
        self.report = {'status': 'running', 'rounds': [], 'checks': {}}

    @staticmethod
    def origin_of(url):
        return url.scheme, url.hostname, url.port or (443 if url.scheme == 'https' else 80)

    async def observe_response(self, request):
        url = urlsplit(request.url)
        if request.method != 'GET' or self.origin_of(url) != self.origin:
            return
        if url.path not in ('/state', '/progress', '/document/status'):
            return
        observed = epoch_ms()
        response = await request.response()
        if not response or not response.ok:
            return
        try:
            data = await response.json()
        except (ValueError, PlaywrightError):
            return
        if not isinstance(data, dict):
            return
        source = data.get('source') if url.path == '/document/status' else data
        if not source:
            return
        if self.tree and source.get('session_id') != self.tree['session_id']:
            if url.path == '/state':
                self.identity_changed = True
            return
        if url.path == '/state':
            if not self.tree or data['revision'] >= self.tree['revision']:
                self.tree = data
            self.compare_answers(data)
        elif url.path == '/progress':
            self.progress.append((observed, response.headers.get('x-grow-me-instance'), data))
        elif not self.document or (source['revision'], data['server_now'], data['sequence']) >= (
            self.document['source']['revision'], self.document['server_now'], self.document['sequence'],
        ):
            self.document = data

    def compare_answers(self, tree):
        nodes = {node['id']: node for node in tree['nodes']}
        for node_id, (revision, expected) in self.expected.items():
            if tree['revision'] >= revision:
                matches = answer_matches(nodes.get(node_id, {}).get('answer'), expected)
                self.answer_checks[node_id] = self.answer_checks.get(node_id, True) and matches

    def button(self, name):
        return self.page.get_by_role('button', name=name, exact=True)

    def marker(self, node_id):
        escaped = ''.join(f'\\{ord(character):x} ' for character in node_id)
        return self.page.locator(f'.tree-node[data-node-id="{escaped}"]')

    async def open_question(self, node):
        await self.marker(node['id']).click()
        dialog = self.page.locator('#node-dialog')
        await dialog.locator('.question-form').wait_for()
        require(await dialog.get_attribute('data-node-id') == node['id'], '页面打开了另一道题。')
        return dialog

    async def fill_answer(self, node, dialog, answer, number, position):
        recommended = await dialog.locator('label:has(.recommendation-badge) input').evaluate_all(
            'inputs => inputs.map(input => input.checked)'
        )
        if recommended:
            self.recommendations.append({
                'round': number, 'position': position, 'preselected': any(recommended),
            })
        fields = dialog.locator('.choice-group input')
        for index, option in enumerate(node['options']):
            field = fields.nth(index)
            checked = await field.is_checked()
            wanted = option['id'] in answer['option_ids']
            if checked != wanted:
                if wanted:
                    await field.check()
                elif node['input'] == 'multi_choice':
                    await field.uncheck()
        if node['input'] == 'text':
            await dialog.get_by_role('textbox').fill(answer['text'])
        elif answer['text']:
            await dialog.locator('.notes > summary').click()
            await dialog.get_by_role('textbox').fill(answer['text'])
        await self.button('待定' if answer.get('deferred') else '就这么定').click()
        await dialog.wait_for(state='hidden')
        require(await self.marker(node['id']).get_attribute('data-local') == 'true',
                f'第 {number} 轮第 {position} 题没有形成草稿。')

    async def collect_pauses(self):
        self.pauses.extend(await self.page.evaluate('() => window.simUserPauses.splice(0)'))

    async def reload(self, number, revision, drafts):
        self.step = f'第 {number} 轮刷新后核对草稿'
        result = {'round': number, 'drafts': len(drafts), 'restored': None}
        self.reloads.append(result)
        await self.collect_pauses()
        await self.page.reload(wait_until='domcontentloaded')
        await self.page.locator(f'#meta[data-revision="{revision}"]').wait_for()
        ids = await self.page.locator('.tree-node[data-local=true]').evaluate_all(
            'nodes => nodes.map(node => node.dataset.nodeId)'
        )
        result['restored'] = set(ids) == set(drafts)
        require(result['restored'], '刷新后草稿缺失或增加。')

    async def submit(self, tree, nodes, drafts, enough):
        number, revision = tree['current_round'], tree['revision'] + 1
        self.step = f'第 {number} 轮提交'
        path = '/request-plan' if enough else '/submit'
        if enough:
            await self.button('够了，先出方案').click()
            submit = self.page.get_by_role('dialog').get_by_role('button', name='先出方案', exact=True)
        else:
            await self.button('回看汇总，提交本轮').click()
            submit = self.button('提交本轮答案')
        async with self.page.expect_response(
            lambda response: urlsplit(response.url).path == path and response.request.method == 'POST'
        ) as response_info:
            await submit.click()
        response = await response_info.value
        require(response.ok and (await response.json()).get('revision') == revision,
                f'第 {number} 轮提交未成功。')
        for node in nodes:
            answer = drafts.get(node['id'], {'option_ids': [], 'text': '', 'deferred': True})
            self.expected[node['id']] = (revision, answer)
        if self.tree:
            self.compare_answers(self.tree)
        submission = {
            'round': number, 'revision': revision, 'kind': 'request_plan' if enough else 'submit',
            'answered_from_preset': len(drafts), 'automatically_deferred': len(nodes) - len(drafts),
            'receipt_observed_at': epoch_ms(),
        }
        self.submissions.append(submission)
        self.report['rounds'].append(submission)

    async def answer_round(self, tree, nodes):
        number = tree['current_round']
        require(number <= len(self.plans), f'第 {number} 轮没有预设。')
        plan = self.plans[number - 1]
        enough = 'enough_after' in plan
        count = plan.get('enough_after', len(nodes))
        require(count <= len(nodes) and plan.get('reload_after', 0) <= count,
                f'第 {number} 轮题数少于预设的刷新或出方案位置。')
        matches = match_answers(nodes, plan.get('answers', []), number)
        drafts = {}
        for index, node in enumerate(nodes[:count], 1):
            self.step = f'第 {number} 轮第 {index} 题'
            require(node['id'] in matches, f'{self.step}没有匹配的预设。')
            answer = expected_answer(node, matches[node['id']], self.step)
            dialog = await self.open_question(node)
            await self.fill_answer(node, dialog, answer, number, index)
            drafts[node['id']] = answer
            if index == plan.get('reload_after'):
                await self.reload(number, tree['revision'], drafts)
        await self.submit(tree, nodes, drafts, enough)

    async def wait_in_browser(self):
        page = self.page
        save = self.button('保存并生成任务文档')
        full = page.get_by_role('link', name='打开完整任务文档', exact=True)
        while True:
            await self.collect_pauses()
            tree = self.tree
            require(not self.identity_changed, '该地址已切换至另一访谈。')
            if tree and await page.locator('#meta').get_attribute('data-revision') == str(tree['revision']):
                require(tree['schema_version'] == 2, '模拟用户需要可答题的 v2 访谈。')
                if self.save_revision is None and await save.is_visible():
                    self.step = '保存并生成任务文档'
                    if self.submissions:
                        self.submissions[-1]['save_button_visible_at'] = epoch_ms()
                    async with page.expect_response(
                        lambda response: urlsplit(response.url).path == '/document/control'
                        and response.request.method == 'POST'
                    ) as response_info:
                        await save.click()
                    response = await response_info.value
                    require(response.ok, '页面保存请求未成功。')
                    self.save_revision = tree['revision'] + 1
                    self.report['save_receipt_observed_at'] = epoch_ms()
                    self.step = '等待完整任务文档'
                elif tree['status'] == 'complete' and self.save_revision is not None:
                    if self.document and self.document['phase'] == 'ready' and await full.is_visible():
                        self.report['document_ready_observed_at'] = epoch_ms()
                        return
                    require(not await self.button('重试生成文档').is_visible(), 'AI 文档生成失败。')
                    ready = await page.locator('.tree-fruit[data-availability=ready]').evaluate_all(
                        'fruits => fruits.map(fruit => fruit.dataset.fruitId)'
                    )
                    if ready and (not self.chapter_steps or set(self.chapter_steps[-1]) != set(ready)):
                        self.chapter_steps.append(ready)
                elif tree['status'] == 'active':
                    nodes = [n for n in tree['nodes'] if n['round'] == tree['current_round']
                             and n['status'] == 'pending']
                    if nodes and tree['current_round'] > self.last_round:
                        if self.submissions:
                            self.submissions[-1]['next_round_visible_at'] = epoch_ms()
                        await self.answer_round(tree, nodes)
                        self.last_round = tree['current_round']
                        self.step = '等待下一轮或保存按钮'
            await asyncio.sleep(0.15)

    async def interview(self):
        self.last_round = 0
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            self.page = await browser.new_page(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            self.page.set_default_timeout(15_000)
            self.page.on('requestfinished', self.observe_response)
            self.page.on('pageerror', lambda _error: setattr(self, 'page_errors', self.page_errors + 1))
            await self.page.add_init_script(WATCH_PAUSES)
            self.step = '打开访谈网页'
            await self.page.goto(self.url, wait_until='domcontentloaded')
            self.step = '等待首轮问题'
            await self.wait_in_browser()
            await browser.close()

    def discovery_report(self):
        events = []
        if self.state_file and self.tree:
            try:
                log = Path(str(self.state_file) + '.runtime-timings.jsonl')
                with log.open(encoding='utf-8', errors='replace') as stream:
                    for line in stream:
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(event, dict) and event.get('session_id') == self.tree['session_id']:
                            events.append(event)
            except OSError:
                pass
        discoveries = {event['sequence']: event for event in reversed(events)
                       if event.get('event') == 'submission_discovered'
                       and {'sequence', 'discovery_delay_ms', 'submission_at', 'at'} <= event.keys()}
        submissions = {(event['round'], event['revision'], event['kind']): event for event in events
                       if event.get('event') == 'user_event'
                       and {'round', 'revision', 'kind', 'sequence'} <= event.keys()}
        measured = 0
        for result in self.submissions:
            submit = submissions.get((result['round'], result['revision'], result['kind']))
            first = discoveries.get(submit['sequence']) if submit else None
            result['discovery_delay_ms'] = first['discovery_delay_ms'] if first else None
            result['discovery_status'] = MEASURED if first else UNTESTED
            if first:
                measured += 1
                result['submitted_at'] = first['submission_at']
                result['first_discovered_at'] = first['at']
        return {
            'status': MEASURED if measured and measured == len(self.submissions) else UNTESTED,
            'measured_rounds': measured, 'submitted_rounds': len(self.submissions),
        }

    def presence_reports(self):
        thinking = {entry['revision']: entry for entry in self.submissions}
        windows = {revision: 'thinking' for revision in thinking}
        if self.save_revision is not None:
            windows[self.save_revision] = 'saved'
        samples = {revision: [] for revision in windows}
        for observed, instance, data in self.progress:
            revision = data['revision']
            if data['stage'] != windows.get(revision):
                continue
            if (revision == self.save_revision and self.document and self.document['phase'] in ('ready', 'failed')
                    and data['server_now'] >= self.document['updated_at']):
                continue
            samples[revision].append((observed, instance, data['ai']))
        availability = []
        for revision, window_samples in samples.items():
            availability.append({
                'revision': revision, 'samples': len(window_samples),
                'inactive_samples': sum(not ai['heartbeat_active'] for _, _, ai in window_samples),
                'instance_count': len({instance for _, instance, _ in window_samples}),
            })
        if any(window['inactive_samples'] or window['instance_count'] > 1 for window in availability):
            heartbeat_status = FAILED
        elif availability and all(window['samples'] for window in availability):
            heartbeat_status = PASSED
        else:
            heartbeat_status = UNTESTED

        normal = {revision: entry for revision, entry in thinking.items() if entry['kind'] == 'submit'}
        pauses = [pause for pause in self.pauses if pause['revision'] in normal]
        confirmed = 0
        for pause in pauses:
            preceding = [(observed, ai) for observed, _, ai in samples[pause['revision']]
                         if 0 <= pause['observed_at'] - observed <= 1500]
            if preceding and max(preceding, key=lambda sample: sample[0])[1]['heartbeat_active']:
                confirmed += 1
        completed = sum('next_round_visible_at' in entry or 'save_button_visible_at' in entry
                        for entry in normal.values())
        if confirmed:
            pause_status = FAILED
        elif pauses or not completed or completed != len(normal):
            pause_status = UNTESTED
        else:
            pause_status = PASSED
        return {
            'status': pause_status, 'notices': len(pauses), 'confirmed_false': confirmed,
            'unclassified': len(pauses) - confirmed, 'completed_windows': completed,
        }, {'status': heartbeat_status, 'windows': availability}

    def chapter_report(self):
        chapters = self.document['chapters'] if self.document and self.save_revision is not None else []
        steps = [len(step) for step in self.chapter_steps]
        published = [chapter['first_published_at'] for chapter in chapters if chapter['first_published_at'] is not None]
        result = {
            'status': UNTESTED, 'chapter_count': len(chapters),
            'first_published_at': sorted(published), 'visible_preview_counts': steps,
        }
        # A poll may miss a preview. Publication timestamps alone cannot distinguish
        # a multi-chapter preview command from consecutive single-chapter commands.
        if (len(chapters) > 1 and len(published) == len(chapters)
                and steps == list(range(1, len(chapters) + 1))
                and set(self.chapter_steps[-1]) == {chapter['id'] for chapter in chapters}):
            result['status'] = PASSED
        return result

    def score(self):
        pauses, heartbeat = self.presence_reports()
        checked = len(self.answer_checks)
        changed = sum(not value for value in self.answer_checks.values())
        preselected = sum(item['preselected'] for item in self.recommendations)
        lost = any(item['restored'] is False for item in self.reloads)
        restored = self.reloads and all(item['restored'] is True for item in self.reloads)
        self.report['checks'] = {
            'recommendation_preselected': {
                'status': FAILED if preselected else PASSED if self.recommendations else UNTESTED,
                'observations': self.recommendations,
            },
            'answers_unchanged': {
                'status': FAILED if changed else PASSED if checked and checked == len(self.expected) else UNTESTED,
                'expected': len(self.expected), 'checked': checked, 'changed': changed,
            },
            'draft_survives_reload': {
                'status': FAILED if lost else PASSED if restored else UNTESTED, 'reloads': self.reloads,
            },
            'chapters_published_sequentially': self.chapter_report(),
            'submission_discovery': self.discovery_report(),
            'false_pause_during_questions': pauses,
            'heartbeat_continuity': heartbeat,
            'idle_wait_false_wakeups': {
                'status': UNTESTED, 'count': None, 'reason': '运行日志没有 AI 等待命令的实际返回记录。',
            },
        }
        self.report['page_error_count'] = self.page_errors
        return self.report


async def run(url, answers, state, timeout):
    actor = None
    try:
        actor = SimUser(url, read_preset(answers), state)
        await asyncio.wait_for(actor.interview(), timeout)
        report = actor.score()
        report['status'] = ('failed' if actor.page_errors or any(
            check['status'] == FAILED for check in report['checks'].values()) else 'completed')
        return report
    except asyncio.TimeoutError:
        status, reason = 'timed_out', '达到总等待上限。'
    except ScenarioError as error:
        status, reason = 'failed', str(error)
    except (OSError, ValueError, PlaywrightError) as error:
        status, reason = 'failed', f'读取预设或操作网页失败（{type(error).__name__}）。'
    report = actor.score() if actor else {'rounds': [], 'checks': {}}
    report.update(status=status, reason=reason, step=actor.step if actor else '读取预设')
    return report


def write_report(report, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    statuses = {'completed': '访谈已保存，全文已生成', 'timed_out': '访谈达到总等待上限', 'failed': '访谈或检查失败'}
    print(f'{statuses[report["status"]]}。已提交 {len(report["rounds"])} 轮。')
    checks = report['checks']
    if checks:
        details = '，'.join(f'{CHECKS[key]}（{check["status"]}）' for key, check in checks.items())
        delays = [f'第 {entry["round"]} 轮 {entry["discovery_delay_ms"]} ms'
                  for entry in report['rounds'] if entry['discovery_delay_ms'] is not None]
        pauses = checks['false_pause_during_questions']
        print(f'{details}。出题期间出现 {pauses["notices"]} 次暂停提示，'
              f'确认误报 {pauses["confirmed_false"]} 次。')
        if delays:
            print(f'AI 首次发现提交用时为{"、".join(delays)}。')
    if report.get('reason'):
        print(f'{report["step"]}时结束。{report["reason"]}')
    return {'completed': 0, 'timed_out': 2, 'failed': 1}[report['status']]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--answers', type=Path, required=True)
    parser.add_argument('--report', type=Path, default=Path('sim-user-report.json'))
    parser.add_argument('--state', type=Path, help='tree.json path for optional runtime timing evidence')
    parser.add_argument('--timeout', type=float, default=1800, help='total time in seconds (default: 1800)')
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be a finite positive number')
    return write_report(asyncio.run(run(args.url, args.answers, args.state, args.timeout)), args.report)


if __name__ == '__main__':
    sys.exit(main())
