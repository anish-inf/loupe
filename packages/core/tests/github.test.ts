import { describe, expect, it, vi } from "vitest";

import { getLastReviewedSha, postReview } from "../src/github";

const ref = { owner: "context-labs", repo: "loupe", pull_number: 13 };
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
const output = {
  summary: "Looks good overall.",
  findings: [],
  concerns: [],
  highlights: ["Small change"],
};

function octokit(
  issueComments: Array<{ id: number; body?: string | null }> = [],
) {
  return {
    paginate: vi.fn(async (method: unknown) => {
      if (method === api.issues.listComments) return issueComments;
      if (method === api.pulls.listReviewComments) return [];
      if (method === api.pulls.listReviews) return [];
      return [];
    }),
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(async () => ({})),
      updateComment: vi.fn(async () => ({})),
    },
    pulls: {
      listReviewComments: vi.fn(),
      listReviews: vi.fn(),
      deleteReviewComment: vi.fn(),
      createReview: vi.fn(async () => ({})),
    },
  };
}
let api: ReturnType<typeof octokit>;

describe("GitHub review publishing", () => {
  it("creates a persistent summary and an inline-only review", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      output,
      [{ path: "src/a.ts", line: 2, severity: "warning", body: "Check this" }],
      [],
      logger,
      { reviewerName: "code", headSha: "a".repeat(40), fileCount: 1 },
    );

    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "",
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("<!-- loupe:code sha="),
          }),
        ],
      }),
    );
    expect(api.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("<!-- loupe:summary:code sha="),
      }),
    );
  });

  it("updates the matching reviewer's summary in place", async () => {
    api = octokit([
      {
        id: 7,
        body: `old\n\n<!-- loupe:summary:code sha=${"b".repeat(40)} -->`,
      },
      {
        id: 8,
        body: `other\n\n<!-- loupe:summary:security sha=${"c".repeat(40)} -->`,
      },
    ]);
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
    });

    expect(api.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 7 }),
    );
    expect(api.issues.createComment).not.toHaveBeenCalled();
    expect(api.pulls.createReview).not.toHaveBeenCalled();
  });

  it("posts a marker-only changes-requested review for a blocker concern", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      {
        ...output,
        concerns: [
          {
            severity: "blocker",
            title: "Unsafe migration",
            detail: "This can lock the table.",
          },
        ],
      },
      [],
      [],
      logger,
      { reviewerName: "code", headSha: "e".repeat(40), fileCount: 1 },
    );

    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        body: expect.stringContaining("<!-- loupe:code sha="),
        comments: [],
      }),
    );
  });

  it("reads the reviewed SHA from the persistent summary", async () => {
    api = octokit([
      {
        id: 7,
        body: `summary\n<!-- loupe:summary:code sha=${"e".repeat(40)} -->`,
      },
    ]);
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "e".repeat(40),
    );
  });

  it("falls back to legacy review markers", async () => {
    api = octokit();
    api.paginate.mockImplementation(async (method: unknown) => {
      if (method === api.issues.listComments) return [];
      if (method === api.pulls.listReviews) {
        return [
          {
            id: 9,
            body: `legacy\n<!-- loupe:code sha=${"f".repeat(40)} -->`,
          },
        ];
      }
      return [];
    });
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "f".repeat(40),
    );
  });
});
