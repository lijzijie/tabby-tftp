import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { IToolbarButton, ToolbarButtonProvider } from 'tabby-core'

import { TftpModalComponent } from './components/tftpModal.component'

const transferIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h11l-3.5-3.5L16 2l6 6-6 6-1.5-1.5L18 9H7V7zm10 10H6l3.5 3.5L8 22l-6-6 6-6 1.5 1.5L6 15h11v2z"/></svg>`

@Injectable()
export class TftpButtonProvider extends ToolbarButtonProvider {
    constructor (private readonly modal: NgbModal) {
        super()
    }

    provide (): IToolbarButton[] {
        return [{
            icon: transferIcon,
            title: 'TFTP 文件传输',
            weight: 6,
            click: () => this.modal.open(TftpModalComponent, { size: 'lg' }),
        }]
    }
}
