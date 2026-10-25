export type Mark = {
  id: string
  type: 'cross' | 'point'
  pageNumber: number
  x: number
  y: number
  label: string
  color: string
  /** CSS pixels at 100% editor zoom; points use diameter, crosses use total width. */
  size: number
}
export type EditorSettings = { crossSize: number; pointSize: number; color: string }
export type ProjectVersion = { id: string; createdAt: string; description: string; marks: Mark[]; settings: EditorSettings }
export type Project = { id: string; name: string; originalFileName: string; createdAt: string; updatedAt: string; pageCount: number; marks: Mark[]; settings: EditorSettings; versions: ProjectVersion[] }
type StoredProject = Project & { pdfKey: string }
const DB_NAME = 'pdf-lot-marker'; const DB_VERSION = 1
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('projects'))db.createObjectStore('projects',{keyPath:'id'});if(!db.objectStoreNames.contains('pdfs'))db.createObjectStore('pdfs')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error??new Error('No se pudo abrir IndexedDB.'))})
}
function transactionDone(tx:IDBTransaction):Promise<void>{return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error??new Error('Error al guardar datos locales.'));tx.onabort=()=>reject(tx.error??new Error('La operación local fue cancelada.'))})}
export async function listProjects():Promise<Project[]>{const db=await openDb();try{const tx=db.transaction('projects','readonly'),rows=await new Promise<StoredProject[]>((resolve,reject)=>{const r=tx.objectStore('projects').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='pdfKey')) as Project).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}finally{db.close()}}
export async function getProject(id:string):Promise<{project:Project;pdfBytes:ArrayBuffer}>{const db=await openDb();try{const tx=db.transaction(['projects','pdfs'],'readonly'),stored=await new Promise<StoredProject>((resolve,reject)=>{const r=tx.objectStore('projects').get(id);r.onsuccess=()=>r.result?resolve(r.result):reject(new Error('No se encontró el proyecto.'));r.onerror=()=>reject(r.error)});const blob=await new Promise<Blob>((resolve,reject)=>{const r=tx.objectStore('pdfs').get(stored.pdfKey);r.onsuccess=()=>r.result?resolve(r.result):reject(new Error('No se encontró el PDF original almacenado.'));r.onerror=()=>reject(r.error)});const project=Object.fromEntries(Object.entries(stored).filter(([key])=>key!=='pdfKey')) as Project;return{project,pdfBytes:await blob.arrayBuffer()}}finally{db.close()}}
export async function saveProject(project:Project,pdfBytes:ArrayBuffer):Promise<void>{const db=await openDb();try{const tx=db.transaction(['projects','pdfs'],'readwrite'),key=project.id;tx.objectStore('pdfs').put(new Blob([pdfBytes.slice(0)],{type:'application/pdf'}),key);tx.objectStore('projects').put({...project,pdfKey:key} satisfies StoredProject);await transactionDone(tx)}catch(error){if(error instanceof DOMException&&error.name==='QuotaExceededError')throw new Error('No hay espacio suficiente en el almacenamiento del navegador. El proyecto no se guardó.');throw error}finally{db.close()}}
export async function deleteProject(id:string):Promise<void>{const db=await openDb();try{const tx=db.transaction(['projects','pdfs'],'readwrite');tx.objectStore('projects').delete(id);tx.objectStore('pdfs').delete(id);await transactionDone(tx)}finally{db.close()}}
