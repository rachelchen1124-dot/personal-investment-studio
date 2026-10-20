export const valuationAnalystPageId = '39e61c547d808010b8d7eaadcb519a9b'

export const nativeToolPaths: Record<string, string> = {
  '39d61c547d8080229e98c3379dd80f19': '/tools',
  [valuationAnalystPageId]: '/valuation-analyst'
}

export function isValuationAnalystPage(pageId: string) {
  return pageId.toLowerCase().replaceAll('-', '').endsWith(valuationAnalystPageId)
}
