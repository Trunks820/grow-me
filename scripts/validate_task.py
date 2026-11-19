"""Check the shared semantic task format; this does not judge business completeness."""
from argparse import ArgumentParser
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
import json
import sys

from read_task import TaskText


WORK_KINDS = {'phase', 'work'}
HEADINGS = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'}
INVISIBLE = {'script', 'style', 'template'}
BLOCKS = TaskText.blocks | {'h5', 'h6', 'br', 'hr', 'td', 'th'}


def text(entry, field):
    return ' '.join(''.join(entry['_text'][field]).split())


def refs(entry, key):
    return (entry.get('data-' + key) or '').split()


class Record(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.entries=[]
        self.ids=[]
        self.anchors=[]
        self.revisions=[]
        self.stack=[]

    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        owner, field, visible = self.stack[-1][1:] if self.stack else (None, 'body', True)
        visible = visible and tag not in INVISIBLE
        if a.get('id'): self.ids.append(a['id'])
        if 'data-task-record' in a: self.revisions.append(a.get('data-revision') or '')
        if visible and 'data-kind' in a:
            a['_text'] = {key: [] for key in ('body', 'title', 'goal', 'status')}
            self.entries.append(a)
            owner, field = len(self.entries) - 1, 'body'
        if owner is not None:
            entry = self.entries[owner]
            if a.get('data-field') == 'status':
                field = 'status'
            elif entry['data-kind'] in WORK_KINDS:
                if a.get('data-field') == 'goal':
                    field = 'goal'
                elif field == 'body' and tag in HEADINGS and not text(entry, 'title'):
                    field = 'title'
        if tag == 'a' and (href := a.get('href')) and href.startswith('#'):
            self.anchors.append(unquote(href[1:]))
        if tag in BLOCKS:
            self.add_text(owner, field, visible, ' ')
        if tag not in TaskText.void:
            self.stack.append((tag, owner, field, visible))

    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in TaskText.void:
            self.handle_endtag(tag)

    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                if tag in BLOCKS:
                    self.add_text(*self.stack[i][1:], ' ')
                del self.stack[i:];break

    def handle_data(self,data):
        if self.stack:
            self.add_text(*self.stack[-1][1:], data)

    def add_text(self, owner, field, visible, data):
        if visible and owner is not None:
            self.entries[owner]['_text'][field].append(data)


def manifest_packs(work, questions, index, errors):
    packs = []
    assigned = set()
    for item in work:
        item_id = item['id']
        body = text(item, 'body')
        title = text(item, 'title') or body or text(item, 'goal')
        goal = text(item, 'goal') or body or title
        if not goal:
            errors.append(f'{item_id}: missing readable work title or goal')
        question_ids = list(dict.fromkeys(refs(item, 'questions')))
        assigned.update(question_ids)
        packs.append({
            'id': item_id,
            'title': title,
            'goal': goal,
            'depends_on': refs(item, 'depends'),
            'acceptance_criteria': [f'{ref} · {text(index[ref], "body")}' for ref in refs(item, 'criteria')],
            'open_questions': [questions[ref] for ref in question_ids],
            'external_effects': [],
            'scope_files': [],
            'tags': [],
        })
    unassigned = [question for ref, question in questions.items() if ref not in assigned]
    if unassigned:
        first_root = next((pack for pack in packs if not pack['depends_on']), None)
        if first_root is None:
            errors.append('Unassigned questions need a work item without dependencies')
        else:
            first_root['open_questions'].extend(unassigned)
    return packs


def validate(path, *, handoff=False, expected_questions=()):
    p=Record(); p.feed(Path(path).read_text(encoding='utf-8-sig')); p.close()
    errors=[]; counts=Counter(p.ids)
    for name,n in counts.items():
        if n!=1: errors.append('Duplicate ID: '+name)
    if len(p.revisions)!=1 or not p.revisions[0].strip() or '{{' in p.revisions[0]:
        errors.append('Expected one filled task record revision')
    index={a.get('id'):a for a in p.entries}
    relation={'requirements':{'requirement'},'criteria':{'criterion'},'constraints':{'constraint'},'depends':WORK_KINDS,'questions':{'question'}}
    questions = {}
    for a in p.entries:
        name=a.get('id') or '(missing id)'
        if not a.get('id'): errors.append('Definition missing ID: '+a['data-kind'])
        if 'data-questions' in a and a['data-kind'] not in WORK_KINDS:
            errors.append(f'{name}: data-questions requires a work item or phase')
        for key,kinds in relation.items():
            for ref in refs(a,key):
                if ref not in index: errors.append(f'{name}: missing reference {ref}')
                elif index[ref]['data-kind'] not in kinds: errors.append(f'{name}: wrong reference type {ref}')
        if a['data-kind']=='criterion':
            if not refs(a,'requirements'): errors.append(name+': missing requirement source')
            if text(a, 'status') not in {'passed','failed','unverified','blocked','stale'}:
                errors.append(name+': missing/invalid criterion status')
            if handoff and not text(a, 'body'):
                errors.append(f'{name}: missing readable criterion text')
        if a['data-kind']=='question':
            question = text(a, 'body')
            if not question: errors.append(f'{name}: missing readable question text')
            questions[name] = question
    for anchor in p.anchors:
        if anchor and anchor not in counts: errors.append('Missing anchor: '+anchor)
    requirements=[a for a in p.entries if a['data-kind']=='requirement' and a.get('data-important')!='false']
    criteria=[a for a in p.entries if a['data-kind']=='criterion']
    work=[a for a in p.entries if a['data-kind'] in WORK_KINDS]
    for req in requirements:
        name=req.get('id'); covered=[a for a in criteria if name in refs(a,'requirements')]
        if not covered: errors.append(str(name)+': missing acceptance coverage')
        if work and not any(name in refs(w,'requirements') or set(refs(w,'criteria'))&{c.get('id') for c in covered} for w in work):
            errors.append(str(name)+': missing plan coverage')
    for c in criteria:
        if work and c.get('data-final')!='true' and not any(c.get('id') in refs(w,'criteria') for w in work):
            errors.append(str(c.get('id'))+': missing work-item mapping')
    for question_id, question in expected_questions:
        if questions.get(question_id) != ' '.join(question.split()):
            errors.append(f'{question_id}: missing or changed frozen question')
    packs = manifest_packs(work, questions, index, errors) if handoff and not errors else None
    result = {'valid':not errors,'errors':list(dict.fromkeys(errors)),'requirements':len(requirements),'criteria':len(criteria),'work_entries':len(work),'revision':p.revisions[0] if len(p.revisions)==1 else None,'limits':'Structural links only; not business completeness or executed acceptance.'}
    if handoff and not errors:
        result['packs'] = packs
    return result


if __name__=='__main__':
    args=ArgumentParser(description=__doc__); args.add_argument('page',type=Path)
    args.add_argument('--handoff', action='store_true', help='Include validated packs; read frozen question ID/text pairs from stdin')
    opts=args.parse_args()
    try: result=validate(opts.page, handoff=opts.handoff, expected_questions=json.load(sys.stdin) if opts.handoff else ())
    except (OSError,UnicodeError) as error: args.exit(2,str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['valid'] else 1)
