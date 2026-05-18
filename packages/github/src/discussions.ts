export type DiscussionComment = {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
}

export type Discussion = {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly comments: readonly DiscussionComment[]
}

export type DiscussionsAdapterConfig = {
  readonly token: string
  readonly owner: string
  readonly repo: string
}

export type DiscussionsAdapter = {
  getDiscussion(number: number): Promise<Discussion | null>
  postComment(discussionId: string, body: string): Promise<DiscussionComment>
  listDiscussions(categoryId?: string): Promise<Discussion[]>
}

export function createDiscussionsAdapter(config: DiscussionsAdapterConfig): DiscussionsAdapter {
  const { token, owner, repo } = config

  async function graphql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const startTime = Date.now()

    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    const duration = Date.now() - startTime

    if (!res.ok) {
      const text = await res.text()
      console.error(`[discussions] graphql -> ${res.status} (${duration}ms): ${text}`)
      throw new Error(`GitHub GraphQL ${res.status}: ${text}`)
    }

    const json = await res.json() as { data?: Record<string, unknown>; errors?: { message: string }[] }
    console.log(`[discussions] graphql -> 200 (${duration}ms)`)

    if (json.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`)
    }

    return json.data
  }

  return {
    async getDiscussion(number) {
      const data = await graphql(`
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            discussion(number: $number) {
              id
              number
              title
              body
              comments(first: 100) {
                nodes {
                  id
                  author { login }
                  body
                  createdAt
                  url
                }
              }
            }
          }
        }
      `, { owner, name: repo, number })

      const disc = data.repository.discussion
      if (!disc) return null

      return {
        id: disc.id,
        number: disc.number,
        title: disc.title,
        body: disc.body,
        comments: disc.comments.nodes.map((c: any): DiscussionComment => ({
          id: c.id,
          author: c.author?.login ?? 'unknown',
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      }
    },

    async postComment(discussionId, body) {
      const data = await graphql(`
        mutation($id: ID!, $body: String!) {
          addDiscussionComment(input: {discussionId: $id, body: $body}) {
            comment {
              id
              author { login }
              body
              createdAt
              url
            }
          }
        }
      `, { id: discussionId, body })

      const c = data.addDiscussionComment.comment
      return {
        id: c.id,
        author: c.author?.login ?? 'unknown',
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
      }
    },

    async listDiscussions(categoryId) {
      const categoryFilter = categoryId ? `, categoryId: "${categoryId}"` : ''

      const data = await graphql(`
        query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            discussions(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}${categoryFilter}) {
              nodes {
                id
                number
                title
                body
                comments(first: 100) {
                  nodes {
                    id
                    author { login }
                    body
                    createdAt
                    url
                  }
                }
              }
            }
          }
        }
      `, { owner, name: repo })

      return data.repository.discussions.nodes.map((disc: any): Discussion => ({
        id: disc.id,
        number: disc.number,
        title: disc.title,
        body: disc.body,
        comments: disc.comments.nodes.map((c: any): DiscussionComment => ({
          id: c.id,
          author: c.author?.login ?? 'unknown',
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      }))
    },
  }
}
