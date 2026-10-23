'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');

if (!fs.existsSync(file)) {
  console.error('Не найден index.html в текущей папке.');
  process.exit(1);
}

let html = fs.readFileSync(file, 'utf8');
const original = html;

// 1. Добавляем генератор requestId перед внутренней функцией write().
if (!html.includes('function makeRequestId()')) {
  const anchor = 'function write(){';

  if (!html.includes(anchor)) {
    console.error('Не найдена функция write(). Проверьте, что index.html соответствует репозиторию.');
    process.exit(1);
  }

  html = html.replace(
    anchor,
    `function makeRequestId() {
  var bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map(function(b) { return b.toString(16).padStart(2, '0'); })
    .join('');
}

function write(){`
  );
}

// 2. Отправляем revision и requestId в /api/save.
const oldSaveBody = 'body:JSON.stringify({code:code,data:roomData()})';
const newSaveBody = 'body:JSON.stringify({code:code,revision:Number(syncState.revision||0),requestId:makeRequestId(),data:roomData()})';

if (html.includes(oldSaveBody)) {
  html = html.replace(oldSaveBody, newSaveBody);
} else if (!html.includes(newSaveBody)) {
  console.error('Не найден старый запрос /api/save. Возможно, файл уже исправлен.');
  process.exit(1);
}

// 3. После успешного сохранения обновляем revision.
const oldSaveResult = "if(res&&res.ok===false)throw new Error('Сервер отклонил сохранение');";
const newSaveResult = `if(res&&res.ok===true&&res.protocol===2){
    syncState.revision=res.revision;
   }else if(res&&res.error==='revision_conflict'){
    syncState.revision=res.revision;
    syncNotice('Данные изменены на другом устройстве. Загружаю актуальную версию…',true);
    setTimeout(function(){location.reload();},1200);
    return;
   }else if(res&&res.ok===false){
    throw new Error('Сервер отклонил сохранение');
   }`;

if (html.includes(oldSaveResult)) {
  html = html.replace(oldSaveResult, newSaveResult);
} else if (!html.includes('syncState.revision=res.revision')) {
  console.error('Не найден обработчик ответа /api/save.');
  process.exit(1);
}

// 4. После загрузки данных запоминаем revision сервера.
const oldLoadCheck = 'if(res&&res.ok&&res.data){';
const newLoadCheck = 'if(res&&res.ok){syncState.revision=res.revision;}\n  if(res&&res.ok&&res.data){';

if (html.includes(oldLoadCheck)) {
  html = html.replace(oldLoadCheck, newLoadCheck);
} else if (!html.includes('syncState.revision=res.revision;')) {
  console.error('Не найден обработчик ответа /api/load.');
  process.exit(1);
}

if (html === original) {
  console.log('Изменений не требуется: файл уже исправлен.');
  process.exit(0);
}

fs.writeFileSync(file + '.backup-before-sync-fix.html', original, 'utf8');
fs.writeFileSync(file, html, 'utf8');

console.log('Готово.');
console.log('Исправлен файл:', file);
console.log('Резервная копия:', file + '.backup-before-sync-fix.html');
