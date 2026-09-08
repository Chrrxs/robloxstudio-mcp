// Copyable existing-tool workflow; no server/plugin protocol extension.
import { createHash, randomUUID } from 'node:crypto';

export function luauString(text) {
  return '"' + text.replace(/[\\"\x00-\x1f\x7f]/g, character => `\\${String(character.charCodeAt(0)).padStart(3, '0')}`) + '"';
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function splitUtf8(source, limit) {
  if (!Number.isSafeInteger(limit) || limit < 4) throw new Error('chunkBytes must be an integer >= 4');
  if (!source.isWellFormed()) throw new Error('source must contain valid Unicode, not lone surrogates');
  const chunks = [];
  let characters = [];
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += size;
  }
  if (characters.length) chunks.push(characters.join(''));
  if (!chunks.length) throw new Error('source must not be empty');
  return chunks;
}

export function createLargeInputTransfer({ instanceId, transferId = randomUUID(), source, verification, outputName, chunkBytes = 16 * 1024 }) {
  if (!instanceId) throw new Error('An explicit instanceId is required');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(transferId)) throw new Error('transferId must be a unique 1-80 character identifier');
  if (typeof verification !== 'string' || !verification.trim()) throw new Error('An independent verification program is required');
  if (chunkBytes > 16 * 1024) throw new Error('Keep StringValue chunks at or below this recipe’s conservative 16 KiB byte ceiling');
  const chunks = splitUtf8(source, chunkBytes);
  const manifest = {
    count: chunks.length,
    bytes: Buffer.byteLength(source, 'utf8'),
    sha256: sha256(source),
    chunks: chunks.map(text => ({ bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) })),
  };
  const rootName = `__RSMCP_Transfer_${transferId}`;
  const owner = luauString(transferId);
  const manifestText = JSON.stringify(manifest);
  const prelude = `local storage = game:GetService('ServerStorage')
local owner = ${owner}
local rootName = ${luauString(rootName)}
local manifestText = ${luauString(manifestText)}
local manifestHash = ${luauString(sha256(manifestText))}
local manifest = game:GetService('HttpService'):JSONDecode(manifestText)
local function hash(text)
  -- ComputeStringHash returns raw binary bytes, NOT a printable hex string.
  local raw = game:GetService('EncodingService'):ComputeStringHash(text, Enum.HashAlgorithm.Sha256)
  assert(#raw == 32, 'unexpected SHA256 digest size')
  return (raw:gsub('.', function(byte) return string.format('%02x', string.byte(byte)) end))
end
local function owned(instance)
  assert(instance:GetAttribute('Owner') == owner and instance.Archivable == false, 'unowned or archivable staging object')
end
local function ownedTree(instance)
  owned(instance)
  for _, child in instance:GetDescendants() do owned(child) end
end
local root = nil
for _, child in storage:GetChildren() do
  if child.Name == rootName then assert(root == nil, 'ambiguous staging name') root = child end
end
local function requireRoot()
  assert(root and root:IsA('Folder'), 'missing staging folder')
  owned(root)
  assert(root:GetAttribute('ManifestSHA256') == manifestHash
    and root:GetAttribute('ChunkCount') == manifest.count
    and root:GetAttribute('SourceBytes') == manifest.bytes
    and root:GetAttribute('SourceSHA256') == manifest.sha256, 'transfer manifest mismatch')
  return root
end
local function chunkFolder()
  local folder = requireRoot():FindFirstChild('Chunks')
  assert(folder and folder:IsA('Folder'), 'missing chunk folder')
  owned(folder)
  return folder
end
`;
  // Save the returned arguments before sending. Reuse that exact object only for
  // transport recovery; calling a method again intentionally creates a new step ID.
  const step = code => ({ instance_id: instanceId, target: 'edit', operation_id: randomUUID(), code: prelude + code });
  function indexCheck(index) {
    if (!Number.isInteger(index) || index < 0 || index >= chunks.length) throw new Error('Invalid chunk index');
  }
  return {
    transferId, rootName, outputName, verification, manifest, chunkCount: chunks.length,
    begin: () => step(`if root then
requireRoot()
assert(root:GetAttribute('State') == 'uploading', 'transfer is not uploadable')
return 'ready'
end
root = Instance.new('Folder')
root.Name = rootName root.Archivable = false
root:SetAttribute('Owner', owner) root:SetAttribute('ManifestSHA256', manifestHash) root:SetAttribute('State', 'uploading')
root:SetAttribute('ChunkCount', manifest.count) root:SetAttribute('SourceBytes', manifest.bytes) root:SetAttribute('SourceSHA256', manifest.sha256)
local folder = Instance.new('Folder') folder.Name = 'Chunks' folder.Archivable = false folder:SetAttribute('Owner', owner) folder.Parent = root
root.Parent = storage
return 'ready'`),
    writeChunk(index) {
      indexCheck(index);
      return step(`requireRoot()
assert(root:GetAttribute('State') == 'uploading', 'transfer is not uploadable')
local folder = chunkFolder()
local text = ${luauString(chunks[index])}
local expected = manifest.chunks[${index + 1}]
assert(#text == expected.bytes and hash(text) == expected.sha256, 'incoming chunk mismatch')
local name = 'Chunk${index + 1}'
local chunk = folder:FindFirstChild(name)
if chunk then
owned(chunk)
assert(chunk:IsA('StringValue') and chunk:GetAttribute('Index') == ${index + 1} and chunk.Value == text, 'existing chunk mismatch; abort explicitly')
else
chunk = Instance.new('StringValue') chunk.Name = name chunk.Archivable = false chunk:SetAttribute('Owner', owner) chunk:SetAttribute('Index', ${index + 1}) chunk.Value = text chunk.Parent = folder
end
return 'stored'`);
    },
    readChunk(index) {
      indexCheck(index);
      return step(`local folder = chunkFolder()
local chunk = folder:FindFirstChild('Chunk${index + 1}')
assert(chunk and chunk:IsA('StringValue'), 'missing chunk') owned(chunk)
local expected = manifest.chunks[${index + 1}]
return chunk:GetAttribute('Index') == ${index + 1} and #chunk.Value == expected.bytes and hash(chunk.Value) == expected.sha256`);
    },
    inspect: () => step(`requireRoot() return root:GetAttribute('State')`),
    finalize: () => step(`requireRoot()
local state = root:GetAttribute('State')
if state == 'completed' then return root:GetAttribute('Result') end
assert(state == 'uploading', 'refusing re-execution of '..tostring(state))
local folder = chunkFolder()
ownedTree(root)
assert(#root:GetChildren() == 1, 'unexpected staging objects')
assert(#folder:GetChildren() == manifest.count, 'missing or extra chunks')
local texts = table.create(manifest.count)
for index = 1, manifest.count do
  local chunk = folder:FindFirstChild('Chunk'..index)
  assert(chunk and chunk:IsA('StringValue') and #chunk:GetChildren() == 0, 'missing or invalid chunk')
  assert(chunk:GetAttribute('Index') == index, 'reordered chunk')
  local text = chunk.Value local expected = manifest.chunks[index]
  assert(#text == expected.bytes and hash(text) == expected.sha256, 'corrupt or reordered chunk '..index)
  texts[index] = text
end
local source = table.concat(texts)
assert(#source == manifest.bytes and hash(source) == manifest.sha256, 'assembled source mismatch')
local execute, compileError = loadstring(source, '='..rootName)
assert(execute, compileError)
local verify, verifyError = loadstring(${luauString(verification)}, '=verify_'..rootName)
assert(verify, verifyError)
-- No yielding between observing uploadable state and marking execution.
root:SetAttribute('State', 'executing')
local succeeded, failure = pcall(function()
  execute()
  assert(verify() == true, 'post-execution verification failed')
end)
if not succeeded then
  root:SetAttribute('State', 'failed')
  root:SetAttribute('Error', string.sub(tostring(failure), 1, 1024))
  error(failure)
end
-- Cache completion BEFORE cleanup, so losing the response cannot rerun the recipe.
root:SetAttribute('Result', 'complete')
root:SetAttribute('State', 'completed')
ownedTree(folder)
folder:Destroy()
return 'complete'`),
    abort: () => step(`if not root then return 'absent' end
requireRoot()
assert(root:GetAttribute('State') == 'uploading', 'abort only incomplete, unexecuted transfers')
ownedTree(root)
root:Destroy()
return 'aborted'`),
  };
}

export function deterministicPartsRecipe(transferId, count = 40) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('count must be positive');
  const outputName = `RSMCP_Parts_${transferId}`;
  const name = luauString(outputName);
  const owner = luauString(transferId);
  return {
    outputName,
    source: `-- Unicode survives byte-bounded staging: café 雪 𐍈\nlocal name = ${name}
assert(workspace:FindFirstChild(name) == nil, 'output already exists; inspect, do not replay')
local model = Instance.new('Model') model.Name = name model:SetAttribute('Owner', ${owner})
for index = 1, ${count} do
  local part = Instance.new('Part') part.Name = 'Part'..index part.Anchored = true
  part.Size = Vector3.new(1, 2, 3) part.CFrame = CFrame.new((index - 1) % 10 * 4, math.floor((index - 1) / 10) * 4, 0)
  part.Color = Color3.fromRGB(64, 128, 192) part.Material = Enum.Material.SmoothPlastic
  part:SetAttribute('Owner', ${owner}) part.Parent = model
end
model.Parent = workspace`,
    verification: `local model = workspace:FindFirstChild(${name})
if not model or not model:IsA('Model') or model:GetAttribute('Owner') ~= ${owner} or #model:GetChildren() ~= ${count} then return false end
for index = 1, ${count} do
  local part = model:FindFirstChild('Part'..index)
  if not part or not part:IsA('Part') or not part.Anchored or part:GetAttribute('Owner') ~= ${owner}
    or part.Size ~= Vector3.new(1, 2, 3)
    or part.CFrame ~= CFrame.new((index - 1) % 10 * 4, math.floor((index - 1) / 10) * 4, 0)
    or part.Color ~= Color3.fromRGB(64, 128, 192) or part.Material ~= Enum.Material.SmoothPlastic then return false end
end
return true`,
  };
}
