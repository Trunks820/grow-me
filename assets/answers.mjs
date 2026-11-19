export const isDeferred = answer => answer?.deferred === true;

// Shared answer rules. A recommendation never changes this value.
export function selectionValid(node, answer) {
  if (!answer || !Array.isArray(answer.option_ids) || typeof answer.text !== 'string') return false;
  const ids = answer.option_ids;
  if (!ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) return false;
  if (node.input === 'text')
    return ids.length === 0 && (isDeferred(answer) || answer.text.trim().length > 0);
  if (!ids.length) return isDeferred(answer) && ['single_choice', 'multi_choice'].includes(node.input);
  if (ids.some(id => !node.options.some(option => option.id === id))) return false;
  if (node.input === 'single_choice') return ids.length === 1;
  return (
    node.input === 'multi_choice' &&
    (ids.length === 1 || !node.options.some(option => option.exclusive && ids.includes(option.id)))
  );
}

// Preserve the original encoding for confirmed answers and include an explicit deferral.
export function recommendationBasis(tree, sourceIds) {
  return JSON.stringify(
    sourceIds.map(id => {
      const answer = tree.nodes.find(n => n.id === id)?.answer;
      return {
        id,
        answer: answer
          ? {
              option_ids: answer.option_ids,
              text: answer.text,
              ...(isDeferred(answer) ? { deferred: true } : {})
            }
          : null
      };
    })
  );
}
