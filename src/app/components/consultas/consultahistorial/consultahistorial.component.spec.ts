import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConsultahistorialComponent } from './consultahistorial.component';

describe('ConsultahistorialComponent', () => {
  let component: ConsultahistorialComponent;
  let fixture: ComponentFixture<ConsultahistorialComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConsultahistorialComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ConsultahistorialComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
