import {createHash} from 'node:crypto';
import {recommendationBasis} from '../assets/answers.mjs';
import {answerText} from '../assets/topics.mjs';

export const recommendationDigest = (tree, ids) => createHash('sha256').update(recommendationBasis(tree, ids), 'utf8').digest('hex');

export function bindRecommendations(tree, nodes) {
  for (const node of nodes) if (node.recommendation) {
    node.recommendation.source_digest = recommendationDigest(tree, node.recommendation.source_ids);
  }
}

export function recommendationView(tree, node) {
  const advice = node.recommendation;
  if (!advice) return null;
  const sources = advice.source_ids.map(id => tree.nodes.find(n => n.id === id));
  const stale = sources.some(n => !n || n.status !== 'answered') ||
    (sources.length > 0 && advice.source_digest !== recommendationDigest(tree, advice.source_ids));
  return {kind: 'ai_suggestion', not_confirmed_by_user: true, stale,
    option_ids: stale ? [] : advice.option_ids, reason: advice.reason,
    sources: sources.filter(Boolean).map(n => ({id: n.id, round: n.round, answer: answerText(n)}))};
}
