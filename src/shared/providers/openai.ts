import { JevRequest, JevResponse, OpenAIConfig } from '../types';
import { validateChoiceAnswer } from '../action-space';
import { postJson } from './http';

const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const serialize = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v);

/** Translate the browser's Jev contract without changing its offered actions or loop policy. */
export async function callOpenAI(config: OpenAIConfig, request: JevRequest): Promise<JevResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('OpenAI API Key is not configured. Please set it in Options.');
  const questions: Array<Record<string, unknown>> = [];
  const answers: JevResponse['answers'] = Object.create(null);
  for (const [name, question] of Object.entries(request.questions)) {
    const instructions = serialize(question.instructions);
    if (question.type === 'noul') {
      questions.push({ name, type: 'predicate', instructions });
    } else if (question.type === 'choice') {
      const choices = Object.entries(question.criteria).map(([value, description]) => ({ value, description: serialize(description) }));
      if (!choices.length || choices.length > 255) throw new Error(`OpenAI question "${name}" needs 1–255 candidates.`);
      if (choices.length === 1) {
        // There is no choice to make; the only code-owned target is deterministic.
        const choice = choices[0].value;
        answers[name] = { choice, confidence: 1, probabilities: { [choice]: 1 } };
      } else {
        questions.push({ name, type: 'choice', instructions, choices });
      }
    } else {
      throw new Error(`Unsupported OpenAI decision question type: ${question.type}`);
    }
  }
  const model = config.model.trim() || 'gpt-6-luna';
  if (!questions.length) return { model, answers };
  if (questions.length > 200) throw new Error('OpenAI Decisions supports at most 200 questions.');
  const json = await postJson(
    config.endpoint.trim() || 'https://api.openai.com/v1/decisions',
    { Authorization: `Bearer ${apiKey}` },
    { model, input: JSON.stringify(request.state), questions },
    { label: 'OpenAI Decisions API' }
  );
  if (!Array.isArray(json?.answers)) throw new Error('OpenAI Decisions returned no answer array.');
  const expected = new Map(questions.map((q) => [q.name as string, q.type]));
  const seen = new Set<string>();
  for (const answer of json.answers) {
    const name = answer?.name;
    if (typeof name !== 'string' || !expected.has(name) || seen.has(name)) {
      throw new Error('OpenAI Decisions returned an unknown or duplicate answer name.');
    }
    seen.add(name);
    if (answer.type === 'refusal') throw new Error(`OpenAI Decisions refused question "${name}"; no action executed.`);
    if (answer.type !== expected.get(name)) throw new Error(`OpenAI Decisions returned the wrong answer type for "${name}".`);
    if (answer.type === 'predicate') {
      if (!unit(answer.probability)) throw new Error(`Invalid OpenAI predicate probability for "${name}".`);
      answers[name] = { type: 'noul', probability: answer.probability };
    } else {
      if (!unit(answer.confidence) || !Array.isArray(answer.probabilities)) throw new Error(`Invalid OpenAI choice answer for "${name}".`);
      const probabilities: Record<string, number> = Object.create(null);
      for (const entry of answer.probabilities) {
        if (typeof entry?.value !== 'string' || Object.hasOwn(probabilities, entry.value) || !unit(entry.probability)) {
          throw new Error(`Invalid or duplicate OpenAI probability value for "${name}".`);
        }
        probabilities[entry.value] = entry.probability;
      }
      const question = request.questions[name];
      if (question.type !== 'choice') throw new Error(`Unexpected choice question "${name}".`);
      answers[name] = validateChoiceAnswer({ choice: answer.choice, confidence: answer.confidence, probabilities }, question.criteria);
    }
  }
  if (seen.size !== expected.size) throw new Error('OpenAI Decisions returned missing answers.');
  return { model: json.model || model, answers, usage: json.usage };
}
