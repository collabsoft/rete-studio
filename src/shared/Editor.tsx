import { useCallback, useContext, useEffect, useState } from 'react';
import { CodeFilled, LayoutFilled } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import styled from 'styled-components'
import { useRete } from 'rete-react-render-plugin';
import { createEditor } from '../rete'
import { getLanguage } from '../rete/languages'
import { EnvContext } from '../main';
import { delay } from '../utils/delay';

const SaveButton = styled(Button)`
  position: absolute;
  top: 1em;
  right: 1em;
  z-index: 1;
`
const LayoutButton = styled(Button)`
  position: absolute;
  bottom: 1em;
  right: 1em;
  z-index: 1;
`

function useTask(props: { execute: () => unknown | Promise<unknown>, fail: () => unknown | Promise<unknown> }) {
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null)

  return {
    loading,
    status,
    async execute() {
      try {
        setLoading(true)
        setStatus(null)
        await props.execute()
      } catch (e) {
        await props.fail()
        setStatus({ type: 'error', message: (e as Error).message })
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
  }
}

export function useEditor(props: { code: string | undefined, autoCode?: boolean }) {
  const env = useContext(EnvContext)
  const create = useCallback((container: HTMLElement) => {
    const language = env?.current
    if (!language) throw new Error('Language not found')

    const lang = getLanguage(language)

    if (!lang) throw new Error(`Language ${language} not found`)

    return createEditor(container, lang)
  }, [createEditor, env?.current])
  const [ref, editor] = useRete(create)
  const [code, setCode] = useState<string | undefined>()
  const codeToGraph = useTask({
    async execute() {
      if (!editor || !props.code) return
      await Promise.all([
        delay(400),
        editor.loadCode(props.code)
      ])
    },
    fail: () => editor?.clear()
  })
  const graphToCode = useTask({
    async execute() {
      if (!editor) return

      const [, code] = await Promise.all([
        delay(400),
        editor.toCode()
      ])

      setCode(code)
    },
    fail: () => setCode('// can\'t transpile graph into code')
  })

  useEffect(() => {
    if (props.code && editor) {
      void async function () {
        await codeToGraph.execute()
        if (props.autoCode !== false) await graphToCode.execute()
      }()
    }

  }, [editor, props.code])

  return {
    codeToGraph,
    graphToCode,
    code,
    maxStep: editor?.maxStep,
    stepNames: editor?.stepNames || [],
    getCurrentStep: () => editor?.getCurrentStep() ?? -1,
    startStepByStep: editor?.startStepByStep,
    currentGraphToCode: editor?.currentGraphToCode,
    stepDown: editor?.stepDown,
    stepUp: editor?.stepUp,
    canvas: (
      <>
        <Tooltip placement="bottom" title="To code">
          <SaveButton onClick={graphToCode.execute} icon={<CodeFilled />} />
        </Tooltip>
        <Tooltip placement="top" title="Layout">
          <LayoutButton onClick={() => editor?.layout()} icon={<LayoutFilled />} />
        </Tooltip>
        <div ref={ref} style={{ height: '100%', width: '100%' }} />
      </>
    )
  }
}
