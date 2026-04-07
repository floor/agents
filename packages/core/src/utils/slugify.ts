export function slugify(text: string): string {
  if (!text) return ''

  // Convert to lowercase
  let slug = text.toLowerCase()

  // Replace non-alphanumeric characters with hyphens
  slug = slug.replace(/[^a-z0-9]+/g, '-')

  // Collapse consecutive hyphens (already handled somewhat by the previous step if we consider sequences of non-alphanumeric chars)
  // Let's refine the replacement to handle multiple separators collapsing into a single hyphen.
  slug = slug.replace(/--+/g, '-')

  // Trim leading/trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '')

  // Truncate to 50 characters
  if (slug.length > 50) {
    slug = slug.substring(0, 50)
  }

  return slug
}
