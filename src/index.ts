/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const headers = { "Content-Type": "application/json" };
		const url = new URL(request.url);

		// If requesting aggregated stats, return category counts from KV
		if (url.pathname === '/stats') {
			try {
				const prefix = 'category:';
				const listResult = await env.FEEDBACK_CACHE.list({ prefix, limit: 1000 });
				const keys = listResult.keys || [];
				const items: Array<{ category: string; occurrences: number }> = [];
				for (const k of keys) {
					const name = k.name;
					const category = name.startsWith(prefix) ? name.slice(prefix.length) : name;
					const val = await env.FEEDBACK_CACHE.get(name);
					const occurrences = val === null ? 0 : (parseInt(val, 10) || 0);
					items.push({ category, occurrences });
				}
				items.sort((a, b) => b.occurrences - a.occurrences);
				return new Response(JSON.stringify(items), { headers });
			} catch (e: any) {
				return new Response(JSON.stringify({ error: 'KV read error', details: e?.message }), { status: 500, headers });
			}
		}
		// If requesting insights, return occurrences, summary, and examples per category
		if (url.pathname === '/insights') {
			try {
				const prefix = 'category:';
				const listResult = await env.FEEDBACK_CACHE.list({ prefix, limit: 1000 });
				const keys = listResult.keys || [];
				const items: Array<{ category: string; occurrences: number; category_summary: string | null; examples: string[] }> = [];
				for (const k of keys) {
					const name = k.name;
					const category = name.startsWith(prefix) ? name.slice(prefix.length) : name;
					const val = await env.FEEDBACK_CACHE.get(name);
					const occurrences = val === null ? 0 : (parseInt(val, 10) || 0);
					const sumKey = `category_summary:${category}`;
					const exKey = `category_examples:${category}`;
					const category_summary = (await env.FEEDBACK_CACHE.get(sumKey)) ?? null;
					let examples: string[] = [];
					const raw = await env.FEEDBACK_CACHE.get(exKey);
					if (raw) {
						try { examples = JSON.parse(raw) as string[]; } catch { examples = []; }
					}
					items.push({ category, occurrences, category_summary, examples });
				}
				items.sort((a, b) => b.occurrences - a.occurrences);
				const wantsHtml = (request.headers.get('accept') || '').includes('text/html') || url.searchParams.get('view') === 'html';
				if (wantsHtml) {
					const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
					const rows = items.map(it => `<tr><td>${esc(it.category)}</td><td>${it.occurrences}</td><td>${esc(it.category_summary ?? '')}</td><td>${esc((it.examples || []).join(' | '))}</td></tr>`).join('');
					const html = `<!doctype html><html><head><meta charset="utf-8"><title>Insights</title></head><body><table border="1" cellpadding="4" cellspacing="0"><thead><tr><th>Category</th><th>Occurrences</th><th>Summary</th><th>Examples</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
					return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
				}
				return new Response(JSON.stringify(items), { headers });
			} catch (e: any) {
				return new Response(JSON.stringify({ error: 'KV read error', details: e?.message }), { status: 500, headers });
			}
		}
		const text = url.searchParams.get("text");
		if (!text) {
			return new Response(
				JSON.stringify({ error: 'Missing "text" query parameter' }),
				{ status: 400, headers }
			);
		}

		try {
			// Ensure table exists, then insert the feedback text.
			await env.feedback_db.prepare(
				`CREATE TABLE IF NOT EXISTS feedback (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					text TEXT,
					created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)`
			).run();

			await env.feedback_db.prepare(
				`INSERT INTO feedback (text) VALUES (?)`
			).bind(text).run();

			// Default AI fields in case the AI call fails
			let sentiment = 'unknown';
			let category = 'unknown';
			let summary = 'N/A';

			try {
				const systemMessage = `You are a strict JSON-only analyzer. Respond with EXACTLY one JSON object and nothing else. The object MUST have keys: \"sentiment\" (one of \"positive\", \"neutral\", or \"negative\"), \"category\" (a short 2-4 word label), and \"summary\" (one concise sentence). Do not include explanations, markdown, or surrounding text.`;
				const userMessage = `Analyze the following feedback and return the JSON described above.\n\nFeedback: ${text}`;

				const combined = `${systemMessage}\n\n${userMessage}`;
				const aiResult = await env.AI.run('gpt-4o-mini', { input: combined });
				const raw =
  					aiResult &&
					typeof aiResult === 'object' &&
  					'response' in aiResult &&
  					typeof aiResult.response === 'string'
    					? aiResult.response
    					: null;

				if (raw) {
  					const firstBrace = raw.indexOf('{');
 	 				const lastBrace = raw.lastIndexOf('}');
  					if (firstBrace !== -1 && lastBrace !== -1) {
    					const json = raw.slice(firstBrace, lastBrace + 1);
    					const parsed = JSON.parse(json);
   						sentiment = parsed.sentiment ?? sentiment;
    					category = parsed.category ?? category;
    					summary = parsed.summary ?? summary;
  					}
				}

			} catch (aiErr) {
				// Keep defaults on any AI error
			}

			// Increment category count in KV
			let occurrences = 0;
			try {
				const kvKey = `category:${category}`;
				const existing = await env.FEEDBACK_CACHE.get(kvKey);
				if (existing === null) {
					occurrences = 1;
				} else {
					const n = parseInt(existing, 10);
					occurrences = Number.isNaN(n) ? 1 : n + 1;
				}
				await env.FEEDBACK_CACHE.put(kvKey, String(occurrences));
			} catch (kvErr) {
				// On KV error, leave occurrences as 0
			}

			// Maintain rolling category summary in KV
			let category_summary = summary;
			try {
				const sumKey = `category_summary:${category}`;
				const existingSummary = await env.FEEDBACK_CACHE.get(sumKey);
				if (existingSummary === null) {
					// No existing summary: store the current summary
					await env.FEEDBACK_CACHE.put(sumKey, summary);
					category_summary = summary;
				} else {
					// Merge existing and new summary via Workers AI
					try {
						const systemMessage = `You are a strict JSON-only assistant. Respond with EXACTLY one JSON object and nothing else. The object MUST have key \"merged_summary\" with one concise sentence that merges the two summaries. Do not include explanations or extra text.`;
						const userMessage = `Merge the existing summary and the new summary into one concise sentence as the merged summary.\n\nExisting summary: ${existingSummary}\n\nNew summary: ${summary}`;

						const aiRes = await env.AI.run('gpt-4o-mini', {
							messages: [
								{ role: 'system', content: systemMessage },
								{ role: 'user', content: userMessage },
							],
						});
												const combinedMerge = `${systemMessage}\n\n${userMessage}`;
												const aiRes = await env.AI.run('gpt-4o-mini', { input: combinedMerge });
												const textOut = aiRes && typeof aiRes.response === 'string' ? aiRes.response.trim() : (typeof aiRes === 'string' ? aiRes.trim() : '');
												try {
													if (textOut) {
														const parsed = JSON.parse(textOut);
														const merged = parsed.merged_summary ?? existingSummary;
														category_summary = merged;
														await env.FEEDBACK_CACHE.put(sumKey, merged);
													} else if (typeof aiRes === 'object' && aiRes !== null) {
														const parsed = aiRes as any;
														const merged = parsed.merged_summary ?? existingSummary;
														category_summary = merged;
														await env.FEEDBACK_CACHE.put(sumKey, merged);
													}
												} catch (e) {
													// On merge parse error, keep existing summary
													category_summary = existingSummary;
												}
								return text ? JSON.parse(text) : null;
							} catch (e) {
								return null;
							}
						};
						const parsed = extractAndParseMerge(aiRes) ?? (typeof aiRes === 'object' ? aiRes : null);
						const merged = parsed?.merged_summary ?? existingSummary;
						category_summary = merged;
						await env.FEEDBACK_CACHE.put(sumKey, merged);
					} catch (mergeErr) {
						// On merge error, keep the existing summary
						category_summary = existingSummary;
					}
				}
			} catch (sumErr) {
				// On KV error, leave category_summary as the current summary
			}

			// Maintain up to 3 example texts per category in KV
			let examples: string[] = [];
			try {
				const exKey = `category_examples:${category}`;
				const raw = await env.FEEDBACK_CACHE.get(exKey);
				if (raw === null) {
					examples = [text];
				} else {
					try {
						const arr = JSON.parse(raw) as string[];
						if (!Array.isArray(arr)) {
							examples = [text];
						} else if (arr.length < 3) {
							arr.push(text);
							examples = arr;
						} else {
							const idx = Math.floor(Math.random() * 3);
							arr[idx] = text;
							examples = arr;
						}
					} catch (parseErr) {
						examples = [text];
					}
				}
				await env.FEEDBACK_CACHE.put(exKey, JSON.stringify(examples));
			} catch (exErr) {
				// On KV error, leave examples as empty array
			}

			return new Response(JSON.stringify({ success: true, text, sentiment, category, summary, category_summary, occurrences, examples }), { headers });
		} catch (err: any) {
			return new Response(JSON.stringify({ error: 'Database error', details: err?.message }), { status: 500, headers });
		}
	},
} satisfies ExportedHandler<Env>;
