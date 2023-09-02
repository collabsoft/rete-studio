const { loadExamples } = require('./src/rete/languages/javascript/tests/utils')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  compiler: {
    styledComponents: true
  },
  env: {
    JS_EXAMPLES: JSON.stringify(loadExamples())
  }
}

module.exports = nextConfig
