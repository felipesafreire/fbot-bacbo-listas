/* FBot Ion — ícones SVG (traço 1.75, estilo Lucide).
   Canônico: bacbo-bot-entradas/public/assets/fbot-icons.js
   As extensões guardam cópia idêntica; editar aqui e copiar.
   Uso: <svg class="ic" aria-hidden="true"><use href="#fbot-i-NOME"></use></svg>
        ou fbotIcon('NOME') em JS. */
(function () {
    'use strict';
    var ICONS = {
        'bolt': '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
        'dice': '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="15.5" cy="15.5" r="1.25"/>',
        'ball': '<circle cx="12" cy="12" r="9"/><path d="m12 7.5 4 2.9-1.5 4.6h-5L8 10.4z"/><path d="M12 3v4.5M16 10.4l4.3-1.4M14.5 15l2.7 3.7M9.5 15l-2.7 3.7M8 10.4 3.7 9"/>',
        'target': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        'radio': '<path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="2"/>',
        'list-check': '<path d="M11 6h10M11 12h10M11 18h10"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
        'alert': '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        'users': '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4.1a4 4 0 0 1 0 7.8M22 21a7 7 0 0 0-4-6.3"/>',
        'user': '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        'download': '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
        'logout': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
        'menu': '<path d="M4 6h16M4 12h16M4 18h16"/>',
        'chevrons-left': '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
        'chevron-down': '<path d="m6 9 6 6 6-6"/>',
        'x': '<path d="M18 6 6 18M6 6l12 12"/>',
        'settings': '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
        'send': '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
        'play': '<path d="M7 4v16l13-8z"/>',
        'stop': '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
        'check': '<path d="M20 6 9 17l-5-5"/>',
        'info': '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
        'ban': '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
        'list': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        'chart': '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
        'bot': '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M2 13v3M22 13v3"/>',
        'flask': '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
        'lock': '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
        'sliders': '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
        'login': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
        'wallet': '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M17 14h.01"/>',
        'layers': '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/>',
        'coins': '<circle cx="9" cy="9" r="6"/><path d="M15.1 9.6A6 6 0 1 1 9.6 15.1"/>',
        'pointer': '<path d="M9 11V5a2 2 0 0 1 4 0v5M13 10V9a2 2 0 0 1 4 0v2M17 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.6-2.8L4 16a2 2 0 0 1 3.2-2.4L9 15.5V11"/>',
        'dot': '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
        'rotate-left': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
        'save': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
        'trash': '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
        'plus': '<path d="M12 5v14M5 12h14"/>',
        'gamepad': '<rect x="2" y="6" width="20" height="12" rx="4"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/>',
        'stethoscope': '<path d="M5 3H4v6a5 5 0 0 0 10 0V3h-1M9 14v1a6 6 0 0 0 11 0v-3"/><circle cx="20" cy="10" r="2"/>',
        'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        'moon': '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
        'terminal': '<path d="m4 17 6-6-6-6M12 19h8"/>',
        'copy': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        'wifi': '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01"/>',
        'flag': '<path d="M4 22V4M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
        'circle-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
        'circle-x': '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
        'rotate': '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
        'hourglass': '<path d="M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4"/>',
        'minimize': '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
        'equals': '<path d="M5 9h14M5 15h14"/>',
        'landmark': '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l9 5H3z"/>',
        'brain': '<path d="M12 5a3 3 0 0 0-5.8-1A3 3 0 0 0 4 9a3 3 0 0 0 0 6 3 3 0 0 0 3 5 3 3 0 0 0 5-1V5z"/><path d="M12 5a3 3 0 0 1 5.8-1A3 3 0 0 1 20 9a3 3 0 0 1 0 6 3 3 0 0 1-3 5 3 3 0 0 1-5-1"/>',
        'eraser': '<path d="m7 21-4-4a2 2 0 0 1 0-3L14 3a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L11 21z"/><path d="M22 21H7M5 11l9 9"/>',
        'delete': '<path d="M10 5h11v14H10l-7-7z"/><path d="m18 9-6 6M12 9l6 6"/>',
        'external': '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        'contrast': '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
        'history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'
    };

    function inject() {
        if (document.getElementById('fbot-icon-sprite')) return;
        var html = '<svg xmlns="http://www.w3.org/2000/svg" id="fbot-icon-sprite" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">';
        for (var name in ICONS) {
            if (Object.prototype.hasOwnProperty.call(ICONS, name)) {
                html += '<symbol id="fbot-i-' + name + '" viewBox="0 0 24 24">' + ICONS[name] + '</symbol>';
            }
        }
        document.body.insertAdjacentHTML('afterbegin', html + '</svg>');
    }

    window.fbotIcon = function (name, extraClass) {
        return '<svg class="ic' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true" focusable="false"><use href="#fbot-i-' + name + '"></use></svg>';
    };
    window.FBOT_ICON_NAMES = Object.keys(ICONS);

    if (document.body) inject();
    else document.addEventListener('DOMContentLoaded', inject);
})();
