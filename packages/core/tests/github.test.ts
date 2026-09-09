import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";

import { getLastReviewedSha, postReview } from "../src/github";
import type { ReviewOutput } from "../src/types";

const ref = { owner: "o", repo: "r", pull_number: 1 };
const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;
const marker = "<!-- loupe:bugs sha=abc1234 -->";
const emptyReview: ReviewOutput = {
  summary: "s",
  concerns: [],
  highlights: [],
  findings: [],
} as unknown as ReviewOutput;

/** Minimal Octokit double: paginate unwraps `data`, everything else is a spy. */
function fakeOctokit(opts: {
  login?: string;
  comments?: unknown[];
  reviews?: unknown[];
}) {
  const deleteReviewComment = vi.fn(async () => ({ data: {} }));
  const createReview = vi.fn(async () => ({ data: {} }));
  const octokit = {
    paginate: async (
      fn: (p: unknown) => Promise<{ data: unknown }>,
      p: unknown,
    ) => (await fn(p)).data,
    pulls: {
      listReviewComments: async () => ({ data: opts.comments ?? [] }),
      listReviews: async () => ({ data: opts.reviews ?? [] }),
      deleteReviewComment,
      createReview,
    },
    users: {
      getAuthenticated: async () => {
        if (!opts.login)
          throw new Error("Resource not accessible by integration");
        return { data: { login: opts.login } };
      },
    },
  };
  return {
    octokit: octokit as unknown as Octokit,
    deleteReviewComment,
    createReview,
  };
}

describe("postReview prior-comment cleanup", () => {
  it("deletes only loupe's own marked comments, never a human quoting the marker", async () => {
    const { octokit, deleteReviewComment } = fakeOctokit({
      login: "loupe-bot",
      comments: [
        {
          id: 1,
          path: "a.ts",
          body: `finding\n\n${marker}`,
          user: { login: "loupe-bot" },
        },
        {
          id: 2,
          path: "a.ts",
          body: `this one is real:\n${marker}`,
          user: { login: "alice" },
        },
        {
          id: 3,
          path: "a.ts",
          body: "unrelated",
          user: { login: "loupe-bot" },
        },
      ],
    });
    await postReview(octokit, ref, emptyReview, [], [], silent, {
      reviewerName: "bugs",
      headSha: "def5678",
      fileCount: 1,
    });
    expect(deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
  });

  it("falls back to github-actions[bot] when the token cannot call GET /user", async () => {
    const { octokit, deleteReviewComment } = fakeOctokit({
      comments: [
        {
          id: 1,
          path: "a.ts",
          body: marker,
          user: { login: "github-actions[bot]" },
        },
        { id: 2, path: "a.ts", body: marker, user: { login: "alice" } },
      ],
    });
    await postReview(octokit, ref, emptyReview, [], [], silent, {
      reviewerName: "bugs",
      headSha: "def5678",
      fileCount: 1,
    });
    expect(deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
  });
});

describe("getLastReviewedSha", () => {
  it("ignores a human review that quotes the marker", async () => {
    const { octokit } = fakeOctokit({
      login: "loupe-bot",
      reviews: [
        {
          body: "<!-- loupe:bugs sha=1111111 -->",
          user: { login: "loupe-bot" },
        },
        {
          body: "quoting: <!-- loupe:bugs sha=2222222 -->",
          user: { login: "alice" },
        },
      ],
    });
    expect(await getLastReviewedSha(octokit, ref, "bugs")).toBe("1111111");
  });
});
