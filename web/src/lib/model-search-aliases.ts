// Chinese aliases users type when searching for a model platform — none of
// the English provider slugs or model ids contain these strings, so without
// this map "千问" / "豆包" / "智谱" return zero hits even though those are
// the brands users learnt the products by.
//
// Each entry maps a CN search token → English tokens that should also be
// considered matches. The picker OR-injects these into the search haystack.

const ALIASES: Record<string, string[]> = {
  // Alibaba family
  "千问": ["qwen", "dashscope", "alibaba"],
  "通义": ["qwen", "dashscope", "alibaba"],
  "通义千问": ["qwen", "dashscope", "alibaba"],
  "百炼": ["dashscope", "alibaba"],
  "阿里": ["alibaba", "dashscope", "qwen"],

  // ByteDance / Volcengine
  "豆包": ["doubao", "ark", "volcengine"],
  "字节": ["doubao", "ark", "volcengine"],
  "火山": ["ark", "volcengine", "doubao"],
  "方舟": ["ark", "volcengine"],

  // Zhipu / Z.AI
  "智谱": ["zai", "glm", "bigmodel"],
  "清华": ["zai", "glm"],

  // Moonshot / Kimi
  "月之暗面": ["kimi", "moonshot"],
  "月暗": ["kimi", "moonshot"],

  // DeepSeek
  "深度求索": ["deepseek"],

  // MiniMax
  "海螺": ["minimax"],

  // Baidu
  "千帆": ["qianfan", "baidu", "ernie"],
  "文心": ["ernie", "qianfan", "baidu"],
  "百度": ["baidu", "qianfan", "ernie"],

  // Tencent
  "腾讯": ["tencent", "hunyuan"],
  "混元": ["hunyuan", "tencent"],

  // Anthropic
  "克劳德": ["claude", "anthropic"],

  // OpenAI
  "奥特曼": ["openai", "gpt"],
};

/**
 * Expand a raw search query so any matching CN alias also widens the
 * haystack with its English equivalents. The original query is preserved
 * so direct English / model-id searches still work normally.
 */
export function expandSearchQuery(rawQuery: string): string {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return query;
  const extras: string[] = [];
  for (const [alias, tokens] of Object.entries(ALIASES)) {
    if (query.includes(alias.toLowerCase())) {
      extras.push(...tokens);
    }
  }
  if (extras.length === 0) return query;
  return [query, ...extras].join(" ");
}
