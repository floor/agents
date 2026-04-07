import { slugify } from '../src/utils/slugify'

describe('slugify', () => {
  it('should convert text to lowercase and replace non-alphanumeric characters with hyphens', () => {
    const text = 'Hello World! This is a Test...';
    // Expected: hello-world-this-is-a-test
    expect(slugify(text)).toBe('hello-world-this-is-a-test')
  })

  it('should collapse consecutive hyphens', () => {
    const text = 'Test---with__multiple spaces';
    // Expected: test-with-multiple-spaces (assuming the implementation handles multiple separators correctly)
    expect(slugify(text)).toBe('test-with-multiple-spaces')
  })

  it('should trim leading and trailing hyphens', () => {
    const text = '-Start and End-';
    // Expected: start-and-end
    expect(slugify(text)).toBe('start-and-end')
  })

  it('should truncate the result to 50 characters if it exceeds the limit', () => {
    // Create a long string of special characters to ensure truncation happens
    const longText = 'a'.repeat(60) + '!@#$%^&*()';
    // The slugification process will likely result in many hyphens. Let's test the final length constraint.
    const expectedSlug = slugify(longText);
    expect(expectedSlug.length).toBeLessThanOrEqual(50);

    // Test a case that is long enough to definitely trigger truncation if it were longer than 50 chars before trimming,
    // but since the logic truncates *after* all other steps, we test the final length constraint.
    const veryLongText = 'a'.repeat(100); // Should result in 100 hyphens or similar structure
    expect(slugify(veryLongText).length).toBe(50)
  })

  it('should handle empty string', () => {
    expect(slugify('')).toBe('')
  })

  it('should handle text with only special characters', () => {
    const text = '!@#$%^&*()';
    // Expected: (empty string after trimming)
    expect(slugify(text)).toBe('')
  })

  it('should handle a simple alphanumeric string correctly', () => {
    const text = 'SimpleString123';
    expect(slugify(text)).toBe('simplestring123')
  })

  it('should handle strings that result in long slugs by truncating', () => {
    // Create a string that forces the slug to be long, testing the 50 char limit.
    const text = 'a'.repeat(60); // Will become 60 hyphens if we replace every character with a hyphen initially and then collapse them.
    // Based on implementation: 'a'.repeat(60) -> 'a'.repeat(60) (lowercase) -> 'a'.repeat(60) (replace non-alnum) -> 'a'.repeat(60) (collapse) -> length 60.
    // If the input is just 'a' * 60, it remains 'a' * 60 if we only replace non-alphanumeric characters.
    // Let's test a string that generates many hyphens:
    const complexText = 'a b c d e f g h i j k l m n o p q r s t u v w x y z 1234567890'; // Length ~45 chars + spaces/punctuation
    // Let's use a string that forces many hyphens:
    const heavyText = 'a!b@c#d$e%f^g&h*i(j)k{l}m[n]o^p%q&r*s(t)u{v}w[x]y^z'; // Length 30, will become 30 hyphens.
    expect(slugify(heavyText).length).toBe(30);

    // Test a string that forces truncation:
    const longInput = 'a'.repeat(51); // Should result in 51 characters if we only replace non-alnum with hyphen and collapse.
    // Since the implementation collapses multiple hyphens, this test is tricky without knowing exact behavior on pure alphanumeric strings.
    // Let's rely on the explicit truncation logic:
    const textForTruncation = 'a'.repeat(51) + '!'; // Should result in 52 characters before final trim/truncate if we treat every char as a separator initially.
    expect(slugify(textForTruncation).length).toBe(50);
  })
})