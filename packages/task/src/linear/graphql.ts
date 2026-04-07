export type LinearAdapterConfig = {
  readonly apiKey: string
  readonly teamId: string
  readonly baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.linear.app'

async function gql(config: LinearAdapterConfig, query: string, variables?: Record<string, unknown>): Promise<any> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': config.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Linear API ${res.status}: ${body}`)
  }

  const json = await res.json() as { data?: unknown; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map(e => e.message).join(', ')}`)
  }

  return json.data
}

export type LinearIssue = {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly state: { readonly name: string; readonly type: string }
  readonly labels: { readonly nodes: { readonly name: string }[] }
  readonly parent: { readonly id: string } | null
  readonly createdAt: string
  readonly updatedAt: string
}

const ISSUE_FIELDS = `
  id
  title
  description
  state { name type }
  labels { nodes { name } }
  parent { id }
  createdAt
  updatedAt
`

export async function getIssuesByLabel(config: LinearAdapterConfig, label: string): Promise<LinearIssue[]> {
  const data = await gql(config, `
    query($teamId: String!, $label: String!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          labels: { name: { eq: $label } }
        }
        orderBy: updatedAt
        first: 100
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `, { teamId: config.teamId, label })

  return data.issues.nodes
}

export async function getIssueById(config: LinearAdapterConfig, issueId: string): Promise<LinearIssue | null> {
  try {
    const data = await gql(config, `
      query($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }
    `, { id: issueId })
    return data.issue
  } catch {
    return null
  }
}

export async function createLinearIssue(config: LinearAdapterConfig, input: {
  title: string
  description?: string
  labelIds?: string[]
  parentId?: string
}): Promise<LinearIssue> {
  const data = await gql(config, `
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue { ${ISSUE_FIELDS} }
      }
    }
  `, {
    input: {
      teamId: config.teamId,
      title: input.title,
      description: input.description,
      labelIds: input.labelIds,
      parentId: input.parentId,
    },
  })

  return data.issueCreate.issue
}

export async function updateLinearIssue(config: LinearAdapterConfig, issueId: string, input: {
  title?: string
  description?: string
  stateId?: string
  labelIds?: string[]
}): Promise<void> {
  await gql(config, `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `, { id: issueId, input })
}

export async function createLinearComment(config: LinearAdapterConfig, issueId: string, body: string): Promise<void> {
  await gql(config, `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId, body })
}

export async function getWorkflowStates(config: LinearAdapterConfig): Promise<{ id: string; name: string; type: string }[]> {
  const data = await gql(config, `
    query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }
  `, { teamId: config.teamId })

  return data.workflowStates.nodes
}

export async function getLabels(config: LinearAdapterConfig): Promise<{ id: string; name: string }[]> {
  const data = await gql(config, `
    query($teamId: String!) {
      issueLabels(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name }
      }
    }
  `, { teamId: config.teamId })

  return data.issueLabels.nodes
}

export async function getIssueLabels(config: LinearAdapterConfig, issueId: string): Promise<{ id: string; name: string }[]> {
  const data = await gql(config, `
    query($id: String!) {
      issue(id: $id) {
        labels { nodes { id name } }
      }
    }
  `, { id: issueId })

  return data.issue.labels.nodes
}
