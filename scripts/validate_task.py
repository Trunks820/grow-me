"""Check the shared semantic task format; this does not judge business completeness."""
from argparse import ArgumentParser
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
import json


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
        if a.get('id'): self.ids.append(a['id'])
        if 'data-task-record' in a: self.revisions.append(a.get('data-revision',''))
        owner=next((x[1] for x in reversed(self.stack) if x[1] is not None),None)
        if 'data-kind' in a:
            a['_status']='';self.entries.append(a);owner=len(self.entries)-1
        if tag=='a' and a.get('href','').startswith('#'): self.anchors.append(unquote(a['href'][1:]))
        if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:
            self.stack.append((tag,owner,a.get('data-field')=='status'))

    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs);self.handle_endtag(tag)

    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                del self.stack[i:];break

    def handle_data(self,data):
        status=next((x for x in reversed(self.stack) if x[2]),None)
        if status and status[1] is not None:self.entries[status[1]]['_status']+=data


def validate(path):
    p=Record(); p.feed(Path(path).read_text(encoding='utf-8-sig')); p.close()
    errors=[]; counts=Counter(p.ids)
    for name,n in counts.items():
        if n!=1: errors.append('Duplicate ID: '+name)
    if len(p.revisions)!=1 or not p.revisions[0].strip() or '{{' in p.revisions[0]:
        errors.append('Expected one filled task record revision')
    index={a.get('id'):a for a in p.entries}
    relation={'requirements':{'requirement'},'criteria':{'criterion'},'constraints':{'constraint'},'depends':{'phase','work'}}
    split=lambda a,key:a.get('data-'+key,'').split()
    for a in p.entries:
        name=a.get('id','(missing id)')
        if 'id' not in a: errors.append('Definition missing ID: '+a['data-kind'])
        for key,kinds in relation.items():
            for ref in split(a,key):
                if ref not in index: errors.append(f'{name}: missing reference {ref}')
                elif index[ref]['data-kind'] not in kinds: errors.append(f'{name}: wrong reference type {ref}')
        if a['data-kind']=='criterion':
            if not split(a,'requirements'): errors.append(name+': missing requirement source')
            if a.get('_status','').strip() not in {'passed','failed','unverified','blocked','stale'}:
                errors.append(name+': missing/invalid criterion status')
    for anchor in p.anchors:
        if anchor and anchor not in counts: errors.append('Missing anchor: '+anchor)
    requirements=[a for a in p.entries if a['data-kind']=='requirement' and a.get('data-important')!='false']
    criteria=[a for a in p.entries if a['data-kind']=='criterion']
    work=[a for a in p.entries if a['data-kind'] in {'phase','work'}]
    for req in requirements:
        name=req.get('id'); covered=[a for a in criteria if name in split(a,'requirements')]
        if not covered: errors.append(str(name)+': missing acceptance coverage')
        if work and not any(name in split(w,'requirements') or set(split(w,'criteria'))&{c.get('id') for c in covered} for w in work):
            errors.append(str(name)+': missing plan coverage')
    for c in criteria:
        if work and c.get('data-final')!='true' and not any(c.get('id') in split(w,'criteria') for w in work):
            errors.append(str(c.get('id'))+': missing work-item mapping')
    return {'valid':not errors,'errors':list(dict.fromkeys(errors)),'requirements':len(requirements),'criteria':len(criteria),'work_entries':len(work),'revision':p.revisions[0] if len(p.revisions)==1 else None,'limits':'Structural links only; not business completeness or executed acceptance.'}


if __name__=='__main__':
    args=ArgumentParser(description=__doc__); args.add_argument('page',type=Path); opts=args.parse_args()
    try: result=validate(opts.page)
    except (OSError,UnicodeError) as error: args.exit(2,str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['valid'] else 1)
