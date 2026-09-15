import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

const markup = document.querySelector('#app-layout')?.innerHTML ?? ''

function Page({ bootstrap }) {
  useEffect(() => {
    bootstrap?.()
  }, [bootstrap])

  return <div id="react-app" dangerouslySetInnerHTML={{ __html: markup }} />
}

export function mount(bootstrap) {
  createRoot(document.getElementById('root')).render(<Page bootstrap={bootstrap} />)
}
