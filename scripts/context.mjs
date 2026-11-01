import {fingerprint} from './document.mjs';
import {answerText} from '../assets/topics.mjs';
import {recommendationView} from './recommendations.mjs';

// A bounded projection, never a second decision record. Explicitly flag abridged answers.
export function interviewContext(tree){
  const clip=(s,n)=>s.length>n?s.slice(0,n)+'…':s;
  return{source:{session_id:tree.session_id,schema_version:tree.schema_version,revision:tree.revision,digest:fingerprint(tree)},topic:tree.topic,current_round:tree.current_round,
    decision_index:tree.nodes.map(n=>({id:n.id,round:n.round,status:n.status,depends_on:n.depends_on})),
    earlier_decisions:tree.nodes.filter(n=>n.round<tree.current_round).map(n=>({id:n.id,question:clip(n.question,60),question_abridged:n.question.length>60,summary:clip(answerText(n),160),abridged:answerText(n).length>160})),
    recent_answers:tree.nodes.filter(n=>n.round===tree.current_round).map(n=>({id:n.id,question:n.question,rationale:n.rationale??null,status:n.status,depends_on:n.depends_on,answer:n.answer,selected_options:n.options.filter(o=>n.answer?.option_ids.includes(o.id)),recommendation:recommendationView(tree,n)})),
    review_ids:tree.nodes.filter(n=>n.status==='needs_review').map(n=>n.id),
    next_action:tree.status==='complete'?'document':tree.nodes.some(n=>n.status==='needs_review')?'review':tree.nodes.every(n=>n.status==='answered')?'questions_or_offer':'wait_for_human'};
}
