// Font Awesome icon set, the same family atsu.moe uses. Atsu runs FA Pro "regular";
// here we use the free regular style where it exists and fall back to free solid.
// Exports keep the old lucide names so call sites stay unchanged.
import { defineComponent, h, type Component } from 'vue';
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import * as solid from '@fortawesome/free-solid-svg-icons';
import * as regular from '@fortawesome/free-regular-svg-icons';

const reg = regular as unknown as Record<string, IconDefinition>;
const sol = solid as unknown as Record<string, IconDefinition>;

function fa(name: string): Component {
  const icon = reg[name] ?? sol[name];
  if (!icon) throw new Error(`Unknown Font Awesome icon: ${name}`);
  return defineComponent({
    name: name.replace(/^fa/, '') + 'Icon',
    inheritAttrs: false,
    setup: (_, { attrs }) => () => h(FontAwesomeIcon, { ...attrs, icon, fixedWidth: false }),
  });
}

export const ArrowDown = fa('faArrowDown');
export const ArrowUp = fa('faArrowUp');
export const ArrowLeft = fa('faArrowLeft');
export const Bell = fa('faBell');
export const Check = fa('faCheck');
export const CheckCheck = fa('faCheckDouble');
export const ChevronDown = fa('faChevronDown');
export const ChevronRight = fa('faChevronRight');
export const ChevronUp = fa('faChevronUp');
export const Circle = fa('faCircle');
export const CircleAlert = fa('faCircleExclamation');
export const CircleCheck = fa('faCircleCheck');
export const Download = fa('faDownload');
export const DownloadCloud = fa('faCloudArrowDown');
export const ExternalLink = fa('faArrowUpRightFromSquare');
export const Globe = fa('faGlobe');
export const Inbox = fa('faInbox');
export const Link2 = fa('faLink');
export const Loader2 = fa('faSpinner');
export const Lock = fa('faLock');
export const MessageSquare = fa('faMessage');
export const MessageSquareText = fa('faComments');
export const Package = fa('faBox');
export const Plus = fa('faPlus');
export const RefreshCw = fa('faArrowsRotate');
export const RotateCcw = fa('faRotateLeft');
export const Search = fa('faMagnifyingGlass');
export const Settings = fa('faSliders');
export const SkipForward = fa('faForwardStep');
export const Stethoscope = fa('faStethoscope');
export const Trash2 = fa('faTrashCan');
export const Upload = fa('faUpload');
export const X = fa('faXmark');

export const CircleCheckIcon = CircleCheck;
export const InfoIcon = fa('faCircleInfo');
export const Loader2Icon = Loader2;
export const OctagonXIcon = fa('faCircleXmark');
export const TriangleAlertIcon = fa('faTriangleExclamation');
export const XIcon = X;
