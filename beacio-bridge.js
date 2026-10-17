/**
 * beacio-bridge.js
 * Подключает Web Bluetooth в Safari на iPhone через расширение beacio.
 * Требует установленного приложения beacio из App Store.
 */
(function () {
  'use strict';

  var BEACIO_CDN = 'https://beacio.com/beacio.js';
  var IOS_SAFARI = /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

  var beacioReady = false;

  function showBeacioBanner() {
    if (document.getElementById('beacio-install-banner')) return;

    var banner = document.createElement('div');
    banner.id = 'beacio-install-banner';
    banner.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:calc(84px + env(safe-area-inset-bottom))',
      'z-index:300', 'background:#ffffff', 'border:1px solid #F3C6E0', 'border-radius:16px',
      'padding:14px', 'box-shadow:0 8px 30px rgba(0,0,0,.18)', 'font-family:inherit',
      'color:#4A2440', 'font-size:13px', 'line-height:1.45', 'display:flex', 'gap:10px',
      'align-items:flex-start'
    ].join(';');

    banner.innerHTML =
      '<div style="font-size:22px;flex:none">📶</div>' +
      '<div style="flex:1;min-width:0">' +
        '<b>Bluetooth в Safari</b><br>' +
        'Чтобы подключить BLE-устройство, установите бесплатное приложение <b>beacio</b> из App Store. ' +
        'Оно добавляет поддержку Bluetooth в Safari.' +
        '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
          '<a href="https://apps.apple.com/app/id6761301368" target="_blank" rel="noopener" ' +
             'style="padding:9px 14px;background:#E91E8C;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:12px">Установить beacio</a>' +
          '<button type="button" id="beacio-dismiss" style="padding:9px 14px;background:#FDF0F8;border:1px solid #F3C6E0;border-radius:10px;font-weight:600;font-size:12px;color:#4A2440">Позже</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(banner);
    banner.querySelector('#beacio-dismiss').addEventListener('click', function () {
      banner.remove();
      try { localStorage.setItem('beacio_banner_dismissed', '1'); } catch (e) {}
    });
  }

  function loadScript(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = onload;
    s.onerror = onerror;
    document.head.appendChild(s);
  }

  function initBeacio(onReady) {
    if (!IOS_SAFARI) {
      // На Chrome/Edge Bluetooth уже есть нативно
      onReady(true);
      return;
    }

    // Пытаемся использовать официальный SDK, если он уже есть
    if (window.beacio && typeof window.beacio === 'object') {
      beacioReady = true;
      onReady(true);
      return;
    }

    // Загружаем официальный beacio.js с CDN
    loadScript(BEACIO_CDN, function () {
      // beacio.js выставляет глобальный объект beacio и/или полифилл navigator.bluetooth
      if (navigator.bluetooth || window.beacio) {
        beacioReady = true;
        onReady(true);
      } else {
        onReady(false);
      }
    }, function () {
      onReady(false);
    });
  }

  // Публичный API
  window.BeacioBridge = {
    isIOSSafari: function () { return IOS_SAFARI; },

    ensureReady: function (callback) {
      if (beacioReady) { callback(true); return; }
      initBeacio(function (ok) {
        if (!ok) {
          showBeacioBanner();
        }
        callback(ok);
      });
    },

    showInstallBanner: showBeacioBanner,

    hasBluetooth: function () {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }
  };

  // Автоматически показываем баннер, если Bluetooth нужен, но недоступен
  document.addEventListener('DOMContentLoaded', function () {
    if (IOS_SAFARI && !navigator.bluetooth) {
      // Показываем баннер только если пользователь ранее не закрывал его
      try {
        if (!localStorage.getItem('beacio_banner_dismissed')) {
          // Небольшая задержка, чтобы не мешать загрузке
          setTimeout(showBeacioBanner, 1200);
        }
      } catch (e) {}
    }
  });
})();