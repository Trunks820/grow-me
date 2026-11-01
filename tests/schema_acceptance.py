"""Validate protocol variants with JSON Schema as well as runtime/API regressions."""
import copy,json
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry,Resource

BASE=Path(__file__).resolve().parents[1];file=BASE/'references/tree.schema.json'
schema=json.loads(file.read_text(encoding='utf-8'));schema['$id']=file.as_uri()
legacy=BASE/'references/tree-v1.schema.json';registry=Registry().with_resource(legacy.as_uri(),Resource.from_contents(json.loads(legacy.read_text(encoding='utf-8'))))
validator=Draft202012Validator(schema,registry=registry);Draft202012Validator.check_schema(schema)
sample=json.loads((BASE/'assets/example.tree.json').read_text(encoding='utf-8'));validator.validate(sample)
multi=copy.deepcopy(sample);n=multi['nodes'][0];n.update(input='multi_choice',status='answered',answer={'option_ids':[o['id'] for o in n['options']],'text':'原文\n 🌱'})
validator.validate(multi)
count=2
for change in ['no_reason','blank_reason','single_many','text_options','empty_multi','duplicate','bad_recommendation','two_exclusive']:
    candidate=copy.deepcopy(multi);node=candidate['nodes'][0]
    if change=='no_reason':del node['rationale']
    elif change=='blank_reason':node['rationale']=' \n '
    elif change=='single_many':node['input']='single_choice'
    elif change=='text_options':node['input']='text'
    elif change=='empty_multi':node['answer']['option_ids']=[]
    elif change=='duplicate':node['answer']['option_ids']=[node['options'][0]['id']]*2
    elif change=='bad_recommendation':node['recommendation']={'option_ids':['web'],'reason':'理由','source_ids':['old']}
    else:
        for option in node['options']:option['exclusive']=True
    assert list(validator.iter_errors(candidate)),change;count+=1
old=copy.deepcopy(sample);old['schema_version']=1
for node in old['nodes']:del node['rationale']
validator.validate(old);count+=1
print(json.dumps({'status':'passed','schema_cases':count,'note':'Runtime/API tests additionally enforce ID relationships, dependency cycles, source binding and exclusive selections.'}))
