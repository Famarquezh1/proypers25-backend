import { ComponentFixture, TestBed } from '@angular/core/testing';

import { HistorialVelasComponent } from './historial-velas.component';

describe('HistorialVelasComponent', () => {
  let component: HistorialVelasComponent;
  let fixture: ComponentFixture<HistorialVelasComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HistorialVelasComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(HistorialVelasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
