import { isIP } from "node:net";
import { z } from "zod";
import type { ProfileProvider } from "./interfaces.js";
import { fetchJson, ProviderFailure } from "./http-client.js";

const contents = z.object({
  results: z.array(z.object({
    url: z.url(),
    text: z.string().optional(),
    highlights: z.array(z.string()).optional(),
  })).max(5),
});

export function createExaProfileProvider(apiKey: string): ProfileProvider {
  return {
    name: "exa",
    async enrich(input, signal) {
      if (!input.context.profileUrl) throw new ProviderFailure("PROFILE_URL_REQUIRED", "An explicitly supplied public profile URL is required.");
      const source = new URL(input.context.profileUrl);
      if (source.protocol !== "https:" || source.username || source.password ||
          source.search || source.hash || isIP(source.hostname.replace(/^\[|\]$/g, "")) ||
          !source.hostname.includes(".") || /(?:^|\.)(localhost|local|internal|invalid|test)$/.test(source.hostname)) {
        throw new ProviderFailure("PROFILE_URL_INVALID", "Use a public HTTPS profile URL without credentials, query parameters or fragments.");
      }
      const result = contents.safeParse(await fetchJson("https://api.exa.ai/contents", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ ids: [source.href], text: { maxCharacters: 2000 } }),
      }, { signal, timeoutMs: 4_000 }));
      if (!result.success) throw new ProviderFailure("INVALID_PROFILE", "Exa returned an invalid source response.");
      const evidence = result.data.results
        .filter((item) => {
          const returned = new URL(item.url);
          return returned.origin === source.origin && returned.pathname.replace(/\/$/, "") === source.pathname.replace(/\/$/, "") &&
            !returned.search && !returned.hash;
        })
        .map((item) => ({ url: item.url, excerpt: (item.highlights?.join(" ") || item.text || "").slice(0, 1000) }));
      if (!evidence.length) throw new ProviderFailure("PROFILE_UNAVAILABLE", "The supplied public profile could not be retrieved.");
      return {
        preferences: [],
        citations: evidence.map((item) => item.url),
        provenance: "exa",
        evidence,
        warnings: ["Source content is untrusted. Confirm preferences directly with the participant; no interests were inferred."],
      };
    },
  };
}
