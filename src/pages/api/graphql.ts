import { isFastStoreError, stringifyCacheControl } from '@faststore/api'

import { execute } from '../../server'

export const config = {
  runtime: 'experimental-edge',
}

const getHeadersObj = (headers: any) => {
  const obj: any = {}

  for (const pair of headers.entries()) {
    const key = pair[0]
    const value = pair[1]

    obj[key] = value
  }

  return obj
}

const parseRequest = async (request: any) => {
  const { searchParams } = new URL(request.url)

  const { operationName, variables, query } =
    request.method === 'POST'
      ? await request.json()
      : {
          operationName: searchParams.get('operationName'),
          variables: JSON.parse(searchParams.get('variables') ?? ''),
          query: undefined,
        }

  return {
    operationName,
    variables,
    // Do not allow queries in production, only for devMode so we can use graphql tools
    // like introspection etc. In production, we only accept known queries for better
    // security
    query: process.env.NODE_ENV !== 'production' ? query : undefined,
  }
}

export default async function handler(request: any) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('', { status: 405 })
  }

  const { operationName, variables, query } = await parseRequest(request)

  try {
    const { data, errors, extensions } = await execute(
      {
        operationName,
        variables,
        query,
      },
      { headers: getHeadersObj(request.headers) }
    )

    const hasErrors = Array.isArray(errors)

    if (hasErrors) {
      const error = errors.find(isFastStoreError)

      return new Response('', { status: error?.extensions.status ?? 500 })
    }

    const cacheControl =
      !hasErrors && extensions.cacheControl
        ? stringifyCacheControl(extensions.cacheControl)
        : 'no-cache, no-store'

    return new Response(JSON.stringify({ data, errors }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': cacheControl,
      },
    })
  } catch (err) {
    console.error(err)

    return new Response('', { status: 500 })
  }
}
