import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PDFDocument, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ArrowLeft, ArrowRight, Check, Crosshair, Download, FilePlus2, FileText, Minus, MousePointer2, Plus, Redo2, RotateCcw, Trash2, Undo2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import './App.css'
import { deleteProject as removeStoredProject, getProject, listProjects, saveProject, type Project, type ProjectVersion, type EditorSettings, type Mark } from './projectStore'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type Tool = 'select' | 'cross' | 'point'
const COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#EAB308', '#A855F7']
const DEFAULT_SIZES = { cross: 5, point: 5 } as const
type ViewportSize = { width: number; height: number }

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, width: number, height: number, selected: boolean, zoom: number) {
  const x = mark.x * width, y = mark.y * height, size = Math.max(5, mark.size * zoom)
  ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = Math.max(2, size * .14)
  if (mark.type === 'cross') { ctx.beginPath(); ctx.moveTo(x-size/2,y-size/2); ctx.lineTo(x+size/2,y+size/2); ctx.moveTo(x+size/2,y-size/2); ctx.lineTo(x-size/2,y+size/2); ctx.stroke() }
  else { ctx.beginPath(); ctx.arc(x,y,size/2,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke() }
  if (selected) { ctx.beginPath(); ctx.arc(x,y,size*.85,0,Math.PI*2); ctx.strokeStyle='#2563eb'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]); ctx.stroke() }
  ctx.restore()
}

const PdfCanvas = memo(function PdfCanvas({ pdf, pageNumber, zoom, fitMode, size, onViewport }: { pdf: PDFDocumentProxy; pageNumber: number; zoom: number; fitMode: 'page'|'width'; size: ViewportSize; onViewport: (size: ViewportSize) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let disposed = false
    let task: RenderTask | undefined
    let pageProxy: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const render = async () => {
      try {
        pageProxy = await pdf.getPage(pageNumber)
        if (disposed) return
        const base = pageProxy.getViewport({ scale: 1 })
        const availableWidth = Math.max(100, size.width - 64)
        const availableHeight = Math.max(100, size.height - 48)
        const scale = (fitMode === 'width' ? availableWidth / base.width : Math.min(availableWidth / base.width, availableHeight / base.height)) * zoom
        const viewport = pageProxy.getViewport({ scale })
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`
        onViewport({ width: viewport.width, height: viewport.height })
        const context = canvas.getContext('2d')!
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        console.count(`[PDF.js] page.render page=${pageNumber}`)
        task = pageProxy.render({ canvas, canvasContext: context, viewport })
        await task.promise
      } catch (error) {
        if (!(error instanceof Error && error.name === 'RenderingCancelledException') && !disposed) console.error('PDF page render failed', error)
      }
    }
    void render()
    return () => { disposed = true; task?.cancel() }
  }, [pdf, pageNumber, zoom, fitMode, size.width, size.height, onViewport])
  return <canvas ref={canvasRef} className="pdf-canvas" aria-label={`Página ${pageNumber} del PDF`} />
})

const AnnotationCanvas = memo(function AnnotationCanvas({ marks, selected, width, height, zoom, tool, onPointerDown, onPointerMove, onPointerUp }: { marks: Mark[]; selected: string|null; width: number; height: number; zoom: number; tool: Tool; onPointerDown: (e:ReactPointerEvent<HTMLCanvasElement>)=>void; onPointerMove:(e:ReactPointerEvent<HTMLCanvasElement>)=>void; onPointerUp:()=>void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !width || !height) return
    let frame = 0
    console.count('[Annotations] canvas redraw')
    frame = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(width*dpr); canvas.height = Math.floor(height*dpr)
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height)
      for (const mark of marks) drawMark(ctx,mark,width,height,mark.id===selected,zoom)
    })
    return () => cancelAnimationFrame(frame)
  }, [marks, selected, width, height, zoom])
  return <canvas ref={ref} className={`annotation-canvas ${tool==='select'?'canvas-select':'canvas-place'}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}/>
})

function App() {
  const [file, setFile] = useState<File|null>(null)
  const [project, setProject] = useState<Project|null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectName, setProjectName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'>('saved')
  const [saveRevision, setSaveRevision] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [viewingVersionId, setViewingVersionId] = useState<string|null>(null)

  const projectBytesRef = useRef<ArrayBuffer|null>(null)
  const projectRef = useRef<Project|null>(null)

  const [crossSize, setCrossSize] = useState<number>(DEFAULT_SIZES.cross)
  const [pointSize, setPointSize] = useState<number>(DEFAULT_SIZES.point)
  const [pdf, setPdf] = useState<PDFDocumentProxy|null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [past, setPast] = useState<Mark[][]>([])
  const [future, setFuture] = useState<Mark[][]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState(COLORS[0])
  const currentSize = tool==='point' ? pointSize : crossSize
  const [selected, setSelected] = useState<string|null>(null)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<'page'|'width'>('page')
  const [busy, setBusy] = useState(false)
  const [viewSize, setViewSize] = useState<ViewportSize>({width:0,height:0})
  const [pageSize, setPageSize] = useState<ViewportSize>({width:0,height:0})
  const stageRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const loadingTaskRef = useRef<ReturnType<typeof pdfjs.getDocument>|null>(null)
  const loadSequenceRef = useRef(0)
  const dragRef = useRef<string|null>(null)
  const dragStartRef = useRef<Mark[]|null>(null)
  const marksRef = useRef(marks)
  const isEditorOpen = file !== null
  const activeMark = useMemo(() => marks.find(m=>m.id===selected),[marks,selected])
  const activeProjectId = project?.id
  console.count('[React] App render')

  useEffect(() => {
    const stage=stageRef.current
    if(!stage)return
    const observer=new ResizeObserver(([entry])=>setViewSize({width:entry.contentRect.width,height:entry.contentRect.height}))
    observer.observe(stage)
    return ()=>observer.disconnect()
  },[isEditorOpen])
  useEffect(()=>{marksRef.current=marks},[marks])
  useEffect(()=>{void listProjects().then(setProjects).catch(error=>console.error('Project list failed',error))},[])
  useEffect(()=>{projectRef.current=project},[project])

  useEffect(()=>{
    if(!projectRef.current||!projectBytesRef.current||!file)return
    setSaveStatus('saving')
    const timer=setTimeout(()=>{
      if(dragRef.current)return
      const settings:EditorSettings={crossSize,pointSize,color}
      const current=projectRef.current
      if(!current)return
      const next={...current, name:projectName.trim()||current.name, marks, settings, updatedAt:new Date().toISOString()}
      void saveProject(next,projectBytesRef.current!).then(()=>{setProject(next);setSaveStatus('saved');void listProjects().then(setProjects)}).catch(error=>{console.error('Project autosave failed',error);setSaveStatus('error')})
    },700)
    return()=>clearTimeout(timer)
  },[marks,crossSize,pointSize,color,projectName,activeProjectId,file,saveRevision])

  const attachPdf = useCallback(async(name:string,bytes:ArrayBuffer,loadedProject:Project|null) => {
    const sequence=++loadSequenceRef.current
    const previous=loadingTaskRef.current;loadingTaskRef.current=null;if(previous)void previous.destroy()
    stageRef.current?.scrollTo({top:0,left:0,behavior:'instant'})
    setPdf(null);setPageSize({width:0,height:0})
    try {
      const task=pdfjs.getDocument({data:bytes.slice(0)});loadingTaskRef.current=task
      const doc=await task.promise
      if(sequence!==loadSequenceRef.current){void task.destroy();return}
      setFile(new File([bytes.slice(0)],name,{type:'application/pdf'}));projectBytesRef.current=bytes.slice(0)
      const now=new Date().toISOString(),initial:Project=loadedProject??{id:crypto.randomUUID(),name:name.replace(/\\.pdf$/i,''),originalFileName:name,createdAt:now,updatedAt:now,pageCount:doc.numPages,marks:[],settings:{crossSize:DEFAULT_SIZES.cross,pointSize:DEFAULT_SIZES.point,color:COLORS[0]},versions:[]}
      initial.pageCount=doc.numPages
      setProject(initial);projectRef.current=initial;setProjectName(initial.name);setMarks(initial.marks);marksRef.current=initial.marks
      setCrossSize(initial.settings.crossSize??DEFAULT_SIZES.cross);setPointSize(initial.settings.pointSize??DEFAULT_SIZES.point);setColor(initial.settings.color??COLORS[0])
      setPast([]);setFuture([]);setPage(1);setSelected(null);setPdf(doc);setTotalPages(doc.numPages);setZoom(1)
      if(!loadedProject) {
        try{await saveProject(initial,bytes);void listProjects().then(setProjects);try{localStorage.setItem('pdf-lot-marker:last-project',initial.id)}catch{ /* Optional preference storage may be disabled. */ }}
        catch(error){setSaveStatus('error');console.error('Initial project save failed',error);alert(error instanceof Error?`El PDF se abrió, pero no se pudo guardar el proyecto: ${error.message}`:'El PDF se abrió, pero no se pudo guardar el proyecto.')}
      }
    }catch(error){if(sequence===loadSequenceRef.current){console.error('Project PDF load failed',error);alert('No se pudo abrir el PDF del proyecto. Los datos del proyecto se conservaron.')}}
  },[])
  const loadFile = useCallback(async(next:File) => {
    if(next.type!=='application/pdf')return
    const current=projectRef.current
    if(current&&projectBytesRef.current){const flushed={...current,name:projectName.trim()||current.name,marks:marksRef.current,settings:{crossSize,pointSize,color},updatedAt:new Date().toISOString()};try{await saveProject(flushed,projectBytesRef.current)}catch(error){setSaveStatus('error');alert(error instanceof Error?error.message:'No se pudieron guardar los cambios actuales.');return}}
    await attachPdf(next.name,await next.arrayBuffer(),null)
  },[attachPdf,projectName,crossSize,pointSize,color])
  const openProject = async(id:string) => {try{const stored=await getProject(id);await attachPdf(stored.project.originalFileName,stored.pdfBytes,stored.project);localStorage.setItem('pdf-lot-marker:last-project',id)}catch(error){console.error('Project open failed',error);alert(error instanceof Error?error.message:'No se pudo abrir el proyecto.')}}
  useEffect(()=>()=>{loadSequenceRef.current++;if(loadingTaskRef.current)void loadingTaskRef.current.destroy()},[])
  const onViewport = useCallback((next:ViewportSize)=>setPageSize(current=>current.width===next.width&&current.height===next.height?current:next),[])

  const updateMarks = useCallback((next:Mark[])=>{setPast(prev=>[...prev,marksRef.current]);setFuture([]);marksRef.current=next;setMarks(next)},[])
  const undo=()=>{if(!past.length)return;setFuture(f=>[marks,...f]);setMarks(past[past.length-1]);marksRef.current=past[past.length-1];setPast(p=>p.slice(0,-1))}
  const redo=()=>{if(!future.length)return;setPast(p=>[...p,marks]);setMarks(future[0]);marksRef.current=future[0];setFuture(f=>f.slice(1))}
  const pointerPosition=(e:ReactPointerEvent<HTMLCanvasElement>)=>{const rect=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))}}
  const onPointerDown=(e:ReactPointerEvent<HTMLCanvasElement>)=>{
    const pos=pointerPosition(e),here=marksRef.current.filter(m=>m.pageNumber===page)
    if(tool==='select'){const hit=[...here].reverse().find(m=>Math.hypot((m.x-pos.x)*e.currentTarget.clientWidth,(m.y-pos.y)*e.currentTarget.clientHeight)<Math.max(18,m.size*zoom));setSelected(hit?.id??null);dragRef.current=hit?.id??null;dragStartRef.current=hit?marksRef.current:null;e.currentTarget.setPointerCapture(e.pointerId);return}
    const mark:Mark={id:crypto.randomUUID(),type:tool,pageNumber:page,...pos,label:'',color,size:tool==='point'?Math.max(DEFAULT_SIZES.point,pointSize):crossSize};updateMarks([...marksRef.current,mark]);setSelected(mark.id)
  }
  const onPointerMove=(e:ReactPointerEvent<HTMLCanvasElement>)=>{if(!dragRef.current)return;const pos=pointerPosition(e),next=marksRef.current.map(m=>m.id===dragRef.current?{...m,...pos}:m);marksRef.current=next;setMarks(next)}
  const onPointerUp=()=>{if(!dragRef.current)return;const start=dragStartRef.current;if(start&&start!==marksRef.current){setPast(p=>[...p,start]);setFuture([])}dragRef.current=null;dragStartRef.current=null;setSaveRevision(revision=>revision+1)}
  const deleteSelected=()=>{if(selected)updateMarks(marksRef.current.filter(m=>m.id!==selected));setSelected(null)}
  const createVersion=useCallback(async(description:string, snapshot=marksRef.current)=>{
    const current=projectRef.current;if(!current||!projectBytesRef.current)return null
    const version:ProjectVersion={id:crypto.randomUUID(),createdAt:new Date().toISOString(),description:description.trim()||'Versión manual',marks:structuredClone(snapshot),settings:{crossSize,pointSize,color}}
    const next={...current,versions:[version,...current.versions],updatedAt:new Date().toISOString()};projectRef.current=next;setProject(next)
    try{await saveProject(next,projectBytesRef.current);setSaveStatus('saved');void listProjects().then(setProjects);return version}catch(error){setSaveStatus('error');alert(error instanceof Error?error.message:'No se pudo guardar la versión.');return null}
  },[crossSize,pointSize,color])
  const restoreVersion=useCallback(async(version:ProjectVersion)=>{
    if(!confirm(`¿Restaurar “${version.description}” (${version.marks.length} marcas)? Se guardará una copia de seguridad del estado actual.`))return
    const before=structuredClone(marksRef.current);const backup=await createVersion('Seguridad antes de restaurar',before);if(!backup)return
    const restored=structuredClone(version.marks);marksRef.current=restored;setMarks(restored);setCrossSize(version.settings.crossSize);setPointSize(version.settings.pointSize);setColor(version.settings.color);setHistoryOpen(false)
    const current=projectRef.current!;const restoredEvent:ProjectVersion={id:crypto.randomUUID(),createdAt:new Date().toISOString(),description:`Restaurado: ${version.description}`,marks:structuredClone(restored),settings:version.settings};const next={...current,marks:restored,settings:version.settings,versions:[restoredEvent,...current.versions],updatedAt:new Date().toISOString()};projectRef.current=next;setProject(next);setViewingVersionId(restoredEvent.id)
    try{await saveProject(next,projectBytesRef.current!);setSaveStatus('saved')}catch(error){setSaveStatus('error');alert(error instanceof Error?error.message:'No se pudo guardar la restauración.')}
  },[createVersion])
  const duplicateProject=async(p:Project)=>{try{const stored=await getProject(p.id),copy:Project={...stored.project,id:crypto.randomUUID(),name:`${p.name} (copia)`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versions:structuredClone(p.versions)};await saveProject(copy,stored.pdfBytes);setProjects(await listProjects())}catch(error){alert(error instanceof Error?error.message:'No se pudo copiar el proyecto.')}}
  const eraseProject=async(p:Project)=>{if(!confirm(`¿Eliminar el proyecto “${p.name}” y su PDF local?`))return;try{await removeStoredProject(p.id);setProjects(await listProjects())}catch(error){alert(error instanceof Error?error.message:'No se pudo eliminar el proyecto.')}}
  const changeMark=(patch:Partial<Mark>)=>{if(activeMark)updateMarks(marksRef.current.map(m=>m.id===activeMark.id?{...m,...patch,size:patch.size===undefined?m.size:Math.max(m.type==='point'?DEFAULT_SIZES.point:DEFAULT_SIZES.cross,patch.size)}:m))}
  const changeToolSize=(value:number)=>{if(tool==='point')setPointSize(Math.max(DEFAULT_SIZES.point,value));else setCrossSize(Math.max(DEFAULT_SIZES.cross,value))}
  const download=(blob:Blob,name:string)=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
  const downloadCoords=(format:'json'|'csv')=>{const rows=marks.map(m=>({id:m.id,type:m.type,pageNumber:m.pageNumber,label:m.label,x:Number(m.x.toFixed(6)),y:Number(m.y.toFixed(6)),color:m.color,size:m.size}));const content=format==='json'?JSON.stringify({note:'Coordenadas normalizadas relativas a cada página del PDF; no son coordenadas geográficas ni distancias físicas.',marks:rows},null,2):'id,type,pageNumber,label,x,y,color,size\n'+rows.map(r=>[r.id,r.type,r.pageNumber,`"${r.label.replaceAll('"','""')}"`,r.x,r.y,r.color,r.size].join(',')).join('\n');download(new Blob([content],{type:format==='json'?'application/json':'text/csv'}),`coordenadas.${format}`)}
  const exportPdf=async()=>{
    if(!file||!pdf)return
    setBusy(true)
    try{
      const out=await PDFDocument.load(await file.arrayBuffer())
      for(const mark of marks){
        const pageProxy=await pdf.getPage(mark.pageNumber)
        const baseViewport=pageProxy.getViewport({scale:1})
        const availableWidth=Math.max(100,viewSize.width-64)
        const availableHeight=Math.max(100,viewSize.height-48)
        const fitScale=fitMode==='width'?availableWidth/baseViewport.width:Math.min(availableWidth/baseViewport.width,availableHeight/baseViewport.height)
        const renderedViewport=pageProxy.getViewport({scale:fitScale*zoom})
        const pdfPage=out.getPages()[mark.pageNumber-1]
        const {width:pdfWidth,height:pdfHeight}=pdfPage.getSize()
        const rotation=Math.abs(pdfPage.getRotation().angle)%180===90
        const orientedPdfWidth=rotation?pdfHeight:pdfWidth
        const cssToPdf=orientedPdfWidth/renderedViewport.width
        // `size` is the mark's CSS-pixel diameter/overall width at 100% zoom.
        // renderedViewport already includes zoom, so convert the displayed size only once.
        const sizeCss=Math.max(5,mark.size*zoom)
        const sizePdf=sizeCss*cssToPdf
        const lineWidthPdf=Math.max(2,sizeCss*.14)*cssToPdf
        const c=rgb(parseInt(mark.color.slice(1,3),16)/255,parseInt(mark.color.slice(3,5),16)/255,parseInt(mark.color.slice(5,7),16)/255)
        const x=mark.x*pdfWidth,y=pdfHeight-mark.y*pdfHeight
        if(mark.type==='cross'){
          const half=sizePdf/2
          pdfPage.drawLine({start:{x:x-half,y:y-half},end:{x:x+half,y:y+half},color:c,thickness:lineWidthPdf})
          pdfPage.drawLine({start:{x:x+half,y:y-half},end:{x:x-half,y:y+half},color:c,thickness:lineWidthPdf})
        }else{
          pdfPage.drawCircle({x,y,size:sizePdf/2,color:c,borderColor:rgb(1,1,1),borderWidth:1.5*cssToPdf})
        }
      }
      const saved=await out.save()
      download(new Blob([new Uint8Array(saved).buffer as ArrayBuffer],{type:'application/pdf'}),'plano-marcado.pdf')
    }catch(error){console.error(error);alert('No se pudo exportar el PDF.')}finally{setBusy(false)}
  }

  if(!file)return <main className="landing"><header className="landing-nav"><div className="brand"><span className="brand-icon"><Crosshair size={19}/></span> PDF Lot Marker</div><span className="local-note"><span className="green-dot"/> Proyectos guardados solo en este dispositivo</span></header><section className="hero"><div className="eyebrow"><span className="eyebrow-dot"/> HERRAMIENTA PARA PLANOS INMOBILIARIOS</div><h1>Tu plano, <span>marcado</span><br/>con precisión.</h1><p className="hero-copy">Marca lotes, añade puntos y exporta tus coordenadas en segundos. Todo desde tu navegador.</p><div className="upload-card" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)void loadFile(f)}}><div className="upload-icon"><Upload size={24}/></div><strong>Crear proyecto desde un PDF</strong><span className="upload-sub">Los proyectos y archivos permanecen en este navegador</span><button className="primary-btn" onClick={()=>fileRef.current?.click()}><FilePlus2 size={17}/> Seleccionar PDF <span>↗</span></button><div className="file-hint"><FileText size={14}/> PDF · almacenamiento local</div><input ref={fileRef} hidden type="file" accept="application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void loadFile(f)}}/></div><div className="privacy"><span>🔒</span><div><b>Tus archivos nunca salen de tu dispositivo</b><small>El procesamiento ocurre en el navegador. Guarda copias de seguridad externas si necesitas conservarlos.</small></div></div>{projects.length>0&&<section className="project-list"><h2>Mis proyectos <small>{projects.length}</small></h2>{projects.map(p=><article className="project-card" key={p.id}><button className="project-open" onClick={()=>void openProject(p.id)}><FileText size={18}/><span><b>{p.name}</b><small>{p.pageCount} páginas · {p.marks.length} marcas · Modificado {new Date(p.updatedAt).toLocaleString()}</small></span></button><button className="icon-btn" title="Crear copia" onClick={()=>void duplicateProject(p)}>⧉</button><button className="icon-btn" title="Eliminar proyecto" onClick={()=>void eraseProject(p)}><Trash2 size={15}/></button></article>)}</section>}</section><footer className="landing-footer"><span>PDF LOT MARKER</span><span>Proyectos almacenados localmente</span></footer></main>

  return <main className="editor"><header className="topbar"><button className="brand compact" onClick={()=>{loadSequenceRef.current++;if(loadingTaskRef.current)void loadingTaskRef.current.destroy();loadingTaskRef.current=null;setFile(null);setPdf(null);setTotalPages(0)}}><span className="brand-icon"><Crosshair size={17}/></span> PDF Lot Marker</button><div className="top-file"><FileText size={16}/><span title={file.name}>{file.name}</span></div><input className="project-title-input" aria-label="Nombre del proyecto" value={projectName} onChange={e=>setProjectName(e.target.value)}/><span className={`save-indicator ${saveStatus}`}>{saveStatus==='saving'?'Guardando…':saveStatus==='error'?'Error al guardar':'Guardado'}</span><div className="top-actions"><button className="icon-btn" title="Deshacer" onClick={undo} disabled={!past.length}><Undo2 size={17}/></button><button className="icon-btn" title="Rehacer" onClick={redo} disabled={!future.length}><Redo2 size={17}/></button><span className="divider"/><button className="outline-btn" onClick={()=>setHistoryOpen(v=>!v)}>Historial ({project?.versions.length??0})</button><button className="outline-btn" onClick={()=>{const desc=prompt('Descripción de la versión','Versión manual');if(desc!==null)void createVersion(desc)}}>Guardar versión</button><button className="outline-btn" onClick={()=>downloadCoords('json')}><Download size={15}/> Coordenadas</button><button className="dark-btn" onClick={()=>void exportPdf()} disabled={busy}><Download size={15}/>{busy?'Exportando…':'Exportar PDF'}</button><button className="icon-btn" title="Cargar otro PDF" onClick={()=>fileRef.current?.click()}><FilePlus2 size={17}/></button><input ref={fileRef} hidden type="file" accept="application/pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void loadFile(f)}}/></div></header>
    <section className="toolbar"><div className="tool-group"><button className={`tool-btn ${tool==='select'?'active':''}`} onClick={()=>setTool('select')} title="Seleccionar y mover"><MousePointer2 size={16}/> Seleccionar</button><button className={`tool-btn ${tool==='cross'?'active':''}`} onClick={()=>setTool('cross')}><span className="cross-glyph">×</span> Aspa</button><button className={`tool-btn ${tool==='point'?'active':''}`} onClick={()=>setTool('point')}><span className="point-glyph"/> Punto</button></div><span className="divider"/><div className="color-palette">{COLORS.map(c=><button key={c} className={`color-swatch ${color===c?'chosen':''}`} style={{'--swatch':c} as React.CSSProperties} onClick={()=>setColor(c)} title={c}>{color===c&&<Check size={12}/>}</button>)}</div><span className="divider"/><div className="size-control"><span>Tamaño</span><input type="range" min={tool==='point'?DEFAULT_SIZES.point:DEFAULT_SIZES.cross} max="36" value={currentSize} onChange={e=>changeToolSize(Number(e.target.value))}/><b>{currentSize}</b></div><span className="divider"/><div className="zoom-controls"><button className="icon-btn" onClick={()=>setZoom(z=>Math.max(.35,z-.15))}><Minus size={15}/></button><span>{Math.round(zoom*100)}%</span><button className="icon-btn" onClick={()=>setZoom(z=>Math.min(3,z+.15))}><Plus size={15}/></button></div><button className={`tool-btn fit-btn ${fitMode==='page'?'active':''}`} onClick={()=>{setFitMode('page');setZoom(1)}}>Ajustar página</button><button className={`tool-btn fit-btn ${fitMode==='width'?'active':''}`} onClick={()=>{setFitMode('width');setZoom(1)}}>Ajustar ancho</button><button className="icon-btn delete-btn" title="Eliminar seleccionada" onClick={deleteSelected} disabled={!selected}><Trash2 size={16}/></button></section>
    <div className="workspace"><section className="document-area" ref={stageRef}><div className="canvas-wrap" style={{width:pageSize.width||undefined,height:pageSize.height||undefined}}>{pdf&&<><PdfCanvas pdf={pdf} pageNumber={page} zoom={zoom} fitMode={fitMode} size={viewSize} onViewport={onViewport}/><AnnotationCanvas marks={marks.filter(m=>m.pageNumber===page)} selected={selected} width={pageSize.width} height={pageSize.height} zoom={zoom} tool={tool} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}/></>}</div><div className="page-nav"><button className="icon-btn" disabled={page<=1} onClick={()=>setPage(p=>p-1)}><ArrowLeft size={16}/></button><span>Página <b>{page}</b> de {totalPages}</span><button className="icon-btn" disabled={page>=totalPages} onClick={()=>setPage(p=>p+1)}><ArrowRight size={16}/></button></div><div className="zoom-float"><ZoomOut size={14}/>{Math.round(zoom*100)}%<ZoomIn size={14}/></div></section><aside className="sidebar"><div className="sidebar-heading"><div><h2>Marcas</h2><span>{marks.length} {marks.length===1?'marca':'marcas'} en total</span></div><button className="icon-btn" title="Limpiar marcas de esta página" onClick={()=>{if(marks.some(m=>m.pageNumber===page)&&confirm(`¿Eliminar todas las marcas de la página ${page}?`)){updateMarks(marks.filter(m=>m.pageNumber!==page));setSelected(null)}}}><RotateCcw size={15}/></button></div>{historyOpen&&<section className="version-panel"><h3>Historial de versiones</h3><p>Actual: {marks.length} marcas</p>{(project?.versions??[]).map(v=><div className={`version-row ${viewingVersionId===v.id?'viewing':''}`} key={v.id}><div><b>{v.description}{viewingVersionId===v.id?' · Consultando':''}</b><small>{new Date(v.createdAt).toLocaleString()} · {v.marks.length} marcas ({v.marks.length-marks.length>=0?'+':''}{v.marks.length-marks.length} vs. actual)</small></div><button className="outline-btn" onClick={()=>setViewingVersionId(v.id)}>Ver</button><button className="outline-btn" onClick={()=>void restoreVersion(v)}>Restaurar</button></div>)}</section>}{activeMark&&<div className="edit-card"><div className="edit-title"><span>Editar marca</span><button onClick={()=>setSelected(null)}>×</button></div><label>Etiqueta<input value={activeMark.label} placeholder="Añadir etiqueta…" onChange={e=>setMarks(ms=>ms.map(m=>m.id===activeMark.id?{...m,label:e.target.value}:m))} onBlur={()=>{setPast(p=>[...p,marks]);setFuture([])}}/></label><div className="edit-meta"><span>Pág. {activeMark.pageNumber} · X {activeMark.x.toFixed(4)} · Y {activeMark.y.toFixed(4)}</span></div><div className="edit-colors">{COLORS.map(c=><button key={c} className={`color-swatch ${activeMark.color===c?'chosen':''}`} style={{'--swatch':c} as React.CSSProperties} onClick={()=>changeMark({color:c})}/>)}</div><label className="edit-size">Tamaño <input type="range" min={activeMark.type==='point'?DEFAULT_SIZES.point:DEFAULT_SIZES.cross} max="36" value={activeMark.size} onChange={e=>changeMark({size:Number(e.target.value)})}/>{activeMark.size}</label></div>}{marks.length===0?<div className="empty-marks"><div className="empty-icon"><Crosshair size={21}/></div><b>Aún no hay marcas</b><span>Selecciona una herramienta y haz clic sobre el plano para empezar.</span><div className="shortcut"><MousePointer2 size={14}/> Elige Aspa o Punto arriba</div></div>:<div className="mark-list">{marks.map((m,i)=><button key={m.id} className={`mark-row ${selected===m.id?'selected':''}`} onClick={()=>{setSelected(m.id);setPage(m.pageNumber)}}><span className="mark-symbol" style={{color:m.color}}>{m.type==='cross'?'×':'●'}</span><span className="mark-info"><b>{m.label||`${m.type==='cross'?'Aspa':'Punto'} ${String(i+1).padStart(2,'0')}`}</b><small>Pág. {m.pageNumber} · {m.x.toFixed(3)}, {m.y.toFixed(3)}</small></span><span className="mark-dot" style={{background:m.color}}/></button>)}</div>}<div className="sidebar-footer"><span className="green-dot"/> Coordenadas normalizadas <button className="download-link" onClick={()=>downloadCoords('csv')}>CSV ↓</button></div></aside></div></main>
}
export default App
