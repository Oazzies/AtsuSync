// Font Awesome icons (atsu.moe's icon family: regular style where the free set has it, else solid).
// Rendered as plain inline SVG so they work inside the content script's shadow DOM with no extra CSS.
import type { IconDefinition } from '@fortawesome/fontawesome-common-types';
import { faBell } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowsRotate,
  faArrowUpRightFromSquare,
  faBookOpen,
  faBox,
  faChevronDown,
  faCircleCheck,
  faCircleXmark,
  faCloudArrowDown,
  faDownload,
  faGlobe,
  faLink,
  faLinkSlash,
  faMagnifyingGlass,
  faMinus,
  faPen,
  faPlus,
  faPowerOff,
  faRotateLeft,
  faTrash,
  faUpload,
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

export const ICONS = {
  bell: faBell,
  book: faBookOpen,
  refresh: faArrowsRotate,
  external: faArrowUpRightFromSquare,
  box: faBox,
  chevronDown: faChevronDown,
  check: faCircleCheck,
  xcircle: faCircleXmark,
  download: faDownload,
  cloudDown: faCloudArrowDown,
  globe: faGlobe,
  link: faLink,
  unlink: faLinkSlash,
  search: faMagnifyingGlass,
  minus: faMinus,
  edit: faPen,
  plus: faPlus,
  power: faPowerOff,
  undo: faRotateLeft,
  panel: sidebarOutlineIcon,
  panelOpen: sidebarFilledIcon,
  trash: faTrash,
  upload: faUpload,
  x: faXmark,
} satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICONS;
