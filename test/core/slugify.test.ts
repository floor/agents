import { test, expect } from 'bun:test'
import { slugify } from '@floor-agents/core'

test('converts text to lowercase', () => {
  expect(slugify('Hello World')).toBe('hello-world')
})

test('replaces non-alphanumeric characters with hyphens', () => {
  expect(slugify('Hello World! This is a Test...')).toBe('hello-world-this-is-a-test')
})

test('collapses consecutive hyphens', () => {
  expect(slugify('test---with---dashes')).toBe('test-with-dashes')
})

test('trims leading and trailing hyphens', () => {
  expect(slugify('-start and end-')).toBe('start-and-end')
})

test('truncates to 50 characters', () => {
  expect(slugify('a'.repeat(60)).length).toBe(50)
})

test('handles empty string', () => {
  expect(slugify('')).toBe('')
})

test('handles text with only special characters', () => {
  expect(slugify('!@#$%^&*()')).toBe('')
})

test('handles simple alphanumeric string', () => {
  expect(slugify('SimpleString123')).toBe('simplestring123')
})
