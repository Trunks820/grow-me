// Shared answer rules. A recommendation never changes this value.
export function selectionValid(node, answer) {
  if (!answer || !Array.isArray(answer.option_ids) || typeof answer.text !== 'string') return false;
  const ids = answer.option_ids;
  if (!ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) return false;
  if (node.input === 'text') return ids.length === 0 && answer.text.trim().length > 0;
  if (!ids.length || ids.some(id => !node.options.some(option => option.id === id))) return false;
  if (node.input === 'single_choice') return ids.length === 1;
  return node.input === 'multi_choice' && (ids.length === 1 || !node.options.some(option => option.exclusive && ids.includes(option.id)));
}

// Fixed encoding: source_ids order; each source's id and exact option_ids/text.
export function recommendationBasis(tree, sourceIds) {
  return JSON.stringify(sourceIds.map(id => {
    const node = tree.nodes.find(n => n.id === id);
    return {id, answer: node?.answer ? {option_ids: node.answer.option_ids, text: node.answer.text} : null};
  }));
}
