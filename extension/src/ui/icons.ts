// Font Awesome icons (atsu.moe's icon family: regular style where the free set has it, else solid).
// Rendered as plain inline SVG so they work inside the content script's shadow DOM with no extra CSS.
import type { IconDefinition } from '@fortawesome/fontawesome-common-types';
import { faBell } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowsRotate,
  faArrowUpRightFromSquare,
  faBookOpen,
  faBox,
  faBroom,
  faChevronDown,
  faCircleCheck,
  faCircleXmark,
  faCloudArrowDown,
  faCopy,
  faDownload,
  faFilter,
  faGear,
  faGlobe,
  faLink,
  faLinkSlash,
  faListCheck,
  faMagnifyingGlass,
  faMinus,
  faNoteSticky,
  faPen,
  faPlus,
  faPowerOff,
  faRotateLeft,
  faTrash,
  faTriangleExclamation,
  faUpload,
  faWrench,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

const sidebarOutlineIcon: IconDefinition = {
  prefix: 'fas',
  iconName: 'table-columns',
  icon: [
    24,
    24,
    [],
    '',
    'M4 3H20A2 2 0 0 1 22 5V19A2 2 0 0 1 20 21H4A2 2 0 0 1 2 19V5A2 2 0 0 1 4 3ZM4 5V19H14V5H4ZM16 5V19H20V5H16Z',
  ],
};

const sidebarFilledIcon: IconDefinition = {
  prefix: 'fas',
  iconName: 'table-columns',
  icon: [
    24,
    24,
    [],
    '',
    'M4 3H20A2 2 0 0 1 22 5V19A2 2 0 0 1 20 21H4A2 2 0 0 1 2 19V5A2 2 0 0 1 4 3ZM4 5V19H14V5H4Z',
  ],
};

const windowOutlineIcon: IconDefinition = {
  prefix: 'fas',
  iconName: 'window-maximize',
  icon: [
    24,
    24,
    [],
    '',
    'M4 4H20A2 2 0 0 1 22 6V18A2 2 0 0 1 20 20H4A2 2 0 0 1 2 18V6A2 2 0 0 1 4 4ZM4 8V18H20V8H4Z',
  ],
};

const windowFilledIcon: IconDefinition = {
  prefix: 'fas',
  iconName: 'window-maximize',
  icon: [
    24,
    24,
    [],
    '',
    'M4 4H20A2 2 0 0 1 22 6V18A2 2 0 0 1 20 20H4A2 2 0 0 1 2 18V6A2 2 0 0 1 4 4ZM4 8V18H20V8H4ZM6 10H18V16H6V10Z',
  ],
};

export const ICONS = {
  bell: faBell,
  book: faBookOpen,
  refresh: faArrowsRotate,
  external: faArrowUpRightFromSquare,
  box: faBox,
  broom: faBroom,
  chevronDown: faChevronDown,
  check: faCircleCheck,
  xcircle: faCircleXmark,
  copy: faCopy,
  download: faDownload,
  filter: faFilter,
  cloudDown: faCloudArrowDown,
  globe: faGlobe,
  link: faLink,
  unlink: faLinkSlash,
  listCheck: faListCheck,
  search: faMagnifyingGlass,
  settings: faGear,
  minus: faMinus,
  note: faNoteSticky,
  edit: faPen,
  plus: faPlus,
  power: faPowerOff,
  undo: faRotateLeft,
  panel: sidebarOutlineIcon,
  panelOpen: sidebarFilledIcon,
  window: windowOutlineIcon,
  windowOpen: windowFilledIcon,
  trash: faTrash,
  warning: faTriangleExclamation,
  upload: faUpload,
  wrench: faWrench,
  x: faXmark,
} satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICONS;
